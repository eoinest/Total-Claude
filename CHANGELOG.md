# Changelog

Every version of [total-claude.vercel.app](https://total-claude.vercel.app) that has actually
reached production, newest first.

**Versioning: sequential release numbers — `r1`, `r2`, `r3`…** There is no published API here, so
semver's major/minor distinction would be an arbitrary judgement call on every deploy, and a pure
date would need a disambiguator on the days that ship twice (7 August 2026 shipped two). A monotone
integer says exactly one thing, which is the one thing that is true: how many times this has gone
to production.

Each entry records the commit that was deployed and the Vercel deployment that carried it. Those
are not taken on trust: every commit below was matched to its deployment by comparing the SHA-1 of
every tracked file in the commit against the file digests Vercel holds for that deployment — r1 to
r4 at 100% of tracked files, and r5 at 567 of 568 with zero digest mismatches, the one absent file
being `.gitignore`, which the CLI reads rather than uploads. `r4` and `r5` were additionally
verified by rebuilding the commit in a pinned worktree and diffing the output against the bytes the
live site serves, and by booting all three maps against the live URL and confirming the simulation
clock advances on each. See
[`docs/RELEASING.md`](docs/RELEASING.md) for the procedure.

Every figure quoted here comes from a commit message, from `docs/HANDOFF.md`, or from a measurement
taken while writing this file. Where a claim was later found to be wrong, the corrected version is
what appears — with the correction shown, because on this project the corrections have usually been
more useful than the original findings.

**Every image on this page is our own render**, shot headlessly from the tree it illustrates, at
`--use-gl=angle --use-angle=metal` so it is a real GPU rasterisation and not a software one. The
interface is suppressed unless the entry is *about* the interface, in which case it is shown. Where
a caption says *before* and *after*, both frames are the same named camera on the same scenario with
one thing changed — and where that is not exactly true, the caption says so and says why. Where the frame carries particle VFX the two arms were additionally interleaved
in one session with the base arm re-shot last as a drift check, because two runs of this project at
identical configuration differ on 50-70% of their pixels — the dust reseeds, and a cross-session
pair of a dusty frame is not a comparison. **A caption says only what its picture shows.**
Several entries below carry no image because no honest one could be got, and they are better as
text than as a frame that half-supports them.

---

## r5 — the garrison stops shooting itself, and Carthage's posterns become doors

**18 August 2026** · commit [`850843a`](https://github.com/eoinest/Total-Claude/commit/850843a) ·
deployment `total-claude-dmr7bx7fq` · **live now**

A correctness release, and the one in which several confident diagnoses turned out to be wrong.
Rome's garrison had been putting nearly a third of its shots into its own men and being credited
with more kills than the enemy had bodies. Carthage's posterns were arches painted on solid stone.
A middle-drag panned by however long the frame took rather than by how far the cursor moved. And
the war elephant, which stopped vanishing in r4, stopped pirouetting while it died.

### New

- **The model viewer draws the elephant.** The owner: *"the elephants do not render in the model
  viewer — instead it's just a horse rider."* That is literally what it did, and the readout
  underneath said so — *"soldier mesh + horse mesh"* — beside a comment claiming the fallback would
  stand "until an elephant mesh exists". It had existed for some time. `pushManOrRider` branched on
  `isCavalry`, which is true of `war-elephants` because the roster classes the unit
  **`heavy-cavalry`**: the *simulation* wants a four-tonne animal pushed, shoved and killed like a
  mount, and one entry in the soldier pool is one whole elephant — the beast, its mahout and the
  three men in the tower. `mountKind` is what decides the geometry, and `isElephantUnit` now asks
  it.

  | before — shot at r4 | after — shot at r5 |
  |---|---|
  | ![A model-viewer plate on a plain tan ground with a black-and-white metre staff standing beside it: one Carthaginian rider in a bronze helmet with a shield slung on his back, seated on a bay horse under a red saddlecloth, and a single shadow on the ground under them](docs/images/releases/r4-viewer-horse.jpg) | ![The same plate and the same ground: a grey elephant with a mottled hide, tusks, a wicker crupper and a striped caparison in dye bands over its back, a mahout astride the neck and three crewmen standing in a timber fighting tower strapped over its shoulders, with the metre staff beside its foreleg for scale](docs/images/releases/r5-viewer-elephant.jpg) |
  | `war-elephants` selected in r4: a man on a horse. | The same selection in r5. |

  The animal comes with **alive / mid-death / carcass** as one button each — the carcass is the
  death clip held at its last frame, which is the only elephant pose with an audience measured in
  minutes — its own six clips on its own playhead, the crew placed off the *animated* howdah and
  mahout tracks and thrown clear by the same recipe the game uses, and the 31-bone rig on the
  skeleton overlay. It is one tier: **one draw call, 2,993 triangles, no LOD chain and no
  impostor.** The forward axis was measured rather than assumed, which is the trap this project's
  plate framing has fallen into three times: the barding centroid sits at Z **+1.22 m** against the
  hide's +0.39 and the tower's +0.09, and a four-azimuth sweep of the soloed barding reads
  **53,984 px at azimuth 0 against 31,007 at π**.

- **The isolated-model deck can finally be lit by the lighting the game ships.** Measured off
  `gl.getShaderSource` over every program three had linked, per preset: `studio` 12 fragment
  programs, `field` 15, and **`tcShadowGeom` in none of them**; the new `battle` rig, 28 programs
  with **6**. So every isolated-model plate this project has ever graded — the deck that found the
  inside-out normals, the culled box faces and the reversed shield boss inside an hour — was lit by
  a hand-rolled directional key, a hemisphere and a warm bounce through a fixed 3×3 PCF from one
  non-cascaded sun, standing in for a battle that uses a blocker-search soft shadow across four
  cascades under a physically derived sky. `studio` and `field` are untouched and stay, because
  every archived plate was shot under one of them. An hour slider from 04:00 to 21:00 comes with
  the sky, which is the single most useful knob a lighting review can have and the deck has never
  had one.

- **A changelog, and the procedure that keeps it true.** The owner: *"can you start publishing a
  changelog each time you publish a new version to github."* This file, backfilled to r1, with each
  release matched to its deployment by recomputing the SHA-1 of every tracked file's bytes and
  comparing it against the digests Vercel holds — 434/434, 475/475, 504/504 and 520/520, each
  commit matching only its own deployment, the nearest neighbour scoring 96.2%. And
  [`docs/RELEASING.md`](docs/RELEASING.md), whose ordering is its whole point: pin to an explicit
  commit in a detached worktree, verify by bundle hash rather than status code — a failed Vercel
  build leaves the previous deployment live and still returns 200 — boot all three maps and confirm
  the simulation clock advances, and only then tag and publish. **This release is the first one cut
  by it.**

### Fixed

- **Rome's garrison was shooting itself in the back, and being paid for it.** The report was "73% of
  a garrison's hits are on its own men". That is one sentence and at least three separate faults,
  and the pooled figure is not the one to act on or even to quote: measured per battle, the friendly
  share of every hit on a man was **30.8% on the Rome assault, 63.9% on Carthage and 41.9% in the
  field**. What separates the three faults is the distance from the release point to the hit, so
  every shot now carries where it left from and every friendly casualty is binned by it. **89% of
  them happened within 0.9 m of the muzzle, 0.067 s into flight, on a man in the shooter's own
  rank** — the man standing next to him. The arming guard was `0.06` *seconds*, and a second is not
  a distance: for a ballista bolt at full draw that is 4.7 m, and for the same bolt after the
  parapet solve re-draws it to 6 m/s to clear a merlon at ten paces it is **0.20 m**.

  The ablation is the interesting part, because the obvious fix on its own makes the battle worse:

  | | friendly kills / 4 min | enemy killed |
  |---|---|---|
  | before | 155 | 221 |
  | arming distance alone (1.3 m) | **360** | — |
  | with the lane test fixed | **26** | **539** |

  Arming by distance removes the near-muzzle absorption, so the shaft flies on and takes the man in
  *front* at two metres — and a hit in the back is far more lethal than one in the shoulder
  (`sameUnitAhead` 26 → 701). The fix is the lane test: it stepped at 1.5 m over ranks 0.86 m apart,
  so a man could stand in two thirds of the lane and never be looked at; it ran *before* the
  ballistic solve, against a trajectory nothing flies; and it modelled the lane as a straight ray
  when the shots that hit their own front rank leave at 5-13 m/s and fall 0.38 m over the 1.44 m to
  the second rank. It is now one swept query on the parabola the shot is actually about to fly.
  A unit firing at will also stopped shooting over its own line into a melee — in one 30 s slice,
  **766 of 788 friendly hits were arrows arriving 12 m or more out on a *different* friendly unit**
  — and both halves of that condition are load-bearing, because refusing every melee-locked target
  cost 69 enemy dead to save 3 of our own. An ordered volley still goes in.

  And nobody is credited with shooting his own side any more. **Rome was credited 536 kills over
  four minutes in which its enemy lost 446** — more kills than there were bodies, which is how
  "132 kills while 13 attackers die" happens. After: 597 credited against 661 losses on Rome, 403
  against 403 on Carthage.

  | friendly / enemy kills per minute | before | after |
  |---|---|---|
  | Rome assault | 38.8 / 68.3 | **4.7 / 130.8** |
  | Carthage assault | 19.6 / 21.1 | **3.8 / 42.1** |
  | Campus Martius | 6.0 / 39.4 | **3.7 / 51.8** |

  Friendly share of every hit on a man: Rome **30.8 → 3.6%**, Carthage 63.9 → 19.3%, field
  41.9 → 21.9%. Missiles still hit friendlies, and are meant to.

  *No picture. Which side an arrow came from is not a property of any pixel, and a frame of a
  garrison shooting cannot distinguish the fixed case from the broken one.*

- **Carthage's posterns and gates were drawn, not cut.** r4 stopped the simulation walking columns
  of men through stone by refusing the passage; this release cuts the stone, which is what the wall
  was drawn as having all along. Eight posterns were published as already-open gates, so the city
  duly cut a carriageway through its collision surface for each — but the builder only set a pierced
  arch *panel* into each face and never touched the curtain's own body. Measured with a ray against
  the baked chunks, a postern stopped one at **8.03-8.10 m** — the cityward face — at every height
  from 0.8 to 2.4 m and every lateral offset, and the Porta Byrsae stopped one at **8.4 m** with the
  gate leaves excluded from the test. No man-tick counter in this repo could see it, because they
  all grade men against the obstacle set and the obstacle set agreed with itself.

  | before — shot at r4 | after — shot at r5 |
  |---|---|
  | ![Square on to a postern in the outer face of Carthage's main wall: coursed ashlar filling the frame with a square tower at the left, a chamfered plinth course along the bottom and a row of dark slots under the parapet at the top — and in the middle of the wall an arch about six metres wide drawn as a slightly raised ring with a straight jamb line dropping from each springing, with the wall's own coursing running straight through the middle of it, course for course, at the same brightness, and no opening, no shadow and no vault behind it](docs/images/releases/r4-postern-solid.jpg) | ![The same wall at the same standoff with the tower at the right instead: the arch is now a hole through the masonry, with dressed jambs, a soffit and the near half of the passage in shadow, and through the opening a paved way, an olive and two cypresses on open ground, and one small figure standing on the city side](docs/images/releases/r5-postern-cut.jpg) |
  | The arch as r4 ships it: a relief on solid wall. Behind it the collision raster had a 6 m carriageway. | The same recipe on this release. The passage is stone that is actually gone. |

  The passage is now a single `WallCut` hung on the bay and read by the three things that have to
  agree about it — the stone the main bay lays, the mouth set into the hole, and the stretch of
  gallery that stands down beside it. Two faults were found underneath it and both are fixed:
  **posterns moved from `% 8 === 5` to `% 8 === 6`**, because every `% 8 === 5` bay is also
  `% 4 === 1`, which is the wall-walk ramp's own cadence, so five of them were opening their
  cityward mouth into the side of a 3.4 m masonry ramp; and **the two gate leaves stopped 30 mm
  short of the centreline apiece**, so a 60 mm slot ran down the middle of a shut gate and a ray
  went straight through it. `getUnpiercedGates()` is empty on both circuits and the assertion that
  used to guard this has retired itself. Measured on the deployed tree: **`probe-carthage-wall`
  46/46**, 69 rays cast through the mouths and the carriageway against the drawn stone, no solid
  mouths and no unpierced gates.

- **A middle-drag panned by the clock, not by the cursor.** The drag folded the pointer delta into
  the same accumulator as WASD and the screen edge, normalised that to unit length and then
  multiplied by the frame time — and at the default zoom the normalisation is reached at **1.2 px of
  travel per frame**, so every real drag saturated, the cursor delta was discarded outright, and the
  pan came out as *rate × elapsed time*. The same gesture moved the world by however long the frame
  happened to take, which the new adaptive-quality controller deliberately varies.

  | one 300 px drag over 12 frames, frame duration swept 144 fps → 15 fps | distance | s.d. | max/min |
  |---|---|---|---|
  | before | 16.67 … 160.07 m | 48.58 | 9.60 |
  | after | 19.22 m in every row | **0.00** | **1.00** |

  Held instead at a constant 400 ms of elapsed time with the frame rate swept 15-120, the old code
  returned **80.04 m in all six rows with a standard deviation of exactly 0** — which is the proof
  that it was integrating the clock and had stopped reading the cursor at all. The drag is now a
  difference of two ground points, which telescopes, so twelve frames of 25 px and forty-eight of
  6.25 px land in the same place. Cursor-to-ground tracking error over that 300 px, re-projecting
  the world point that was under the cursor when the drag began: horizontal **25.9 → 6.5 px**,
  vertical **142.2 → 8.9 px**. Two more things fell out of the same block: the vertical axis was
  inverted against the horizontal one, so the camera went backwards as the cursor came down; and the
  drag no longer takes the shift-key speed multiplier, because a 1:1 gesture that moves 2.4× the
  cursor is not 1:1. Keyboard and edge pan are rate gestures, keep the frame time and the diagonal
  normalisation that stops W+D covering `panRate × √2`, and measure **100.05 m and 78.61 m unchanged
  at every frame rate**, s.d. 0 in both arms.

  *No picture. A drag is a gesture over twelve frames; a still frame of the end of it looks the same
  whichever way it got there.*

- **A dying elephant pirouetted 180 degrees, and its crew were thrown under it.** r4 put the animal
  back in the instance buffer; what was left was that the thing now visible turned on the spot while
  it died. The renderer turns a man with no ragdoll pose toward his own death direction, because a
  man's death clip drops him one fixed way and something has to aim it — and an elephant is exempt
  from the ragdoll *by design*, which is the whole of the r4 fix, so it took that branch too. Killed
  from dead astern, the drawn heading **snapped a full 180 degrees on the frame of the killing
  blow**, jumped back to 45.6 degrees when the playhead was zeroed, and swung round to 180 again
  over 0.6 s. Four tonnes pirouetting while it collapses is a stumble, not a death.

  It was three faults rather than one, because three other things are derived from that heading: the
  fall direction is baked into the clip, so turning the animal turns which way it goes down; the
  capsule the living are pushed out of is built on the simulation's facing, which the render turn
  never touched, so the body men avoid was drawn at up to 180 degrees to the body they can see; and
  the crew's landing side is computed off the same heading and **was already backwards**, so the two
  errors cancelled — for a blow from dead ahead or astern, and only by accident. Which side the
  animal lies on is now a measurement rather than a reading of a comment: run the death clip's own
  forward kinematics and at the last frame the right ear, right foreshoulder and right back hip
  finish at y **0.30 / 0.20 / 0.41** against their left-side partners at **1.18 / 1.35 / 1.52**. It
  lies on its right, the tower goes down with it, and a man thrown out of the tower goes that way
  too — now landing at **−2.5 to −3.2 m** to the side, four of four, lying flat 0.13-0.16 m above the
  animal's own ground height. The settled root sink went 1.32 → **1.26 m** from the same kinematics,
  which puts the barrel at 0.94 against a 0.95 target and the lowest bone in the animal at
  **+0.009 m** — nothing under the ground at all.

- **An ala rode straight through a dead elephant.** The carcass pushes the living out of a
  4.7 × 2.6 m capsule, and photographed with a cavalry unit ordered over a body it did not work: the
  squadron settled with riders **1.816 m inside the animal**. Two independent causes, both
  structural. **A horse is not a man, and here that is a shape and not a mass** — the crowd solver
  carries no per-man radius at all, one diameter for everybody, with a rider distinguished only by
  an inverse mass; that is the right model for men shoving each other, where the question is who
  gives way, and the wrong one against a body on the ground, where the question is how wide the
  thing is. A cavalryman is a 2.4 m horse drawn around a point the solver treats as 0.42 m. And
  **the one immovable thing in the tick was served last**: the carcass pass ran at the end of crowd
  resolution and shared its separation budget, so a man in a dense block had already spent the whole
  0.22 m on his neighbours and the correction was dropped entirely — which is exactly the case of a
  formed squadron whose slots happen to lie on a body. A neighbour can be leaned on; a dead elephant
  cannot. Deepest overlap of a rider's own body with the animal's flank **1.816 → 0.224 m**, and of
  a foot soldier's **0.026 m**, with at most 11 of 320 touching at once.

  ![Looking down on a mounted squadron halted around a dead war elephant in long grass: the animal on its side with its timber fighting tower canted over against its shoulder and its legs folded, a scuffed ring of bare earth around it, and about thirty riders in a formed block whose ranks run up to the body, stop, and pick up again beyond it, with none of them standing in it](docs/images/releases/r5-carcass-ala.jpg)

  A squadron ordered straight over the body. What the frame shows is the block opening around the
  carcass and closing again past it. **The "before" here is a number and not a picture** — the
  1.816 m of overlap above was measured, and the frame that went with it was in a screenshot
  directory that no longer exists.

  The whole elephant tier costs **5 draw calls — 1 colour plus 4 shadow cascades — at every camera,
  whether the frame holds one animal or thirty-two and whether they are alive or dead**, so a
  carcass costs nothing. With 32 carcasses on the field at 8,428 men the whole fixed tick measures a
  best block of 3.37 ms against a 4 ms budget, and the carcass pass itself measures −0.035 to
  +0.067 ms, which is inside the noise on either side of zero.

- **A bow is not a weapon at four metres.** A cavalry-versus-archers matchup inverted when the
  friendly-fire fix above let the rear ranks' arrows through, and the diagnosis handed over was that
  the archers were overtuned behind a bug. They are not — see the corrections below. What actually
  happened is that **a hundred archers with a fifty-horse wedge standing in them are not fighting by
  either test the volley machine had**: the wedge presents a tip, five or six men have an opponent,
  the engaged fraction reads 0.05 and the contact lock never sets. So the unit volleyed on with the
  enemy at **1.7 m** — 55 hits and six dead riders in one second, from arrows the lofted solve draws
  to **4.6 m/s** over a two-metre gap and which do full listed damage, because damage is a roster
  number and not a function of speed. Before the friendly-fire fix those arrows were eaten by the
  archers' own front rank at the muzzle, which is why the case read right while being wrong.
  A formation now stops volleying inside **7 m** of an enemy front — not a new number, it is the one
  the pilum volley already used — measured on the front-rank segments, so shooting into the backs of
  a broken enemy is untouched and a garrison shooting down at besiegers is untouched. Leaving the
  volley machine now clears the aim *pose* as well, because the only way out used to be the contact
  lock, on the same tick melee starts, which left a hundred men playing a throw all the way through
  a charge. `cav-vs-archers` **timeout → B at 70 s**, horse losses **24% → 2%**.

- **A skirmisher gave ground to something that outranged him.** Skirmish mode is on by default on
  every skirmisher — the unit's own state summary says "the two toggles start engaged" — and the
  behaviour gave ground to *anything* inside 30 m. Numidian cavalry ordered to attack archers closed
  to 32.9 m, were pushed back to **44.7 m** — the fallback distance times 0.85, exactly — and stood
  there for sixty seconds losing **28 of 54** to a 165 m bow without a man reaching a man. Backing
  off from a swordsman is the whole trade; backing off from 165 m of reach buys him another
  half-minute of shooting. `numidian-vs-archers` **A 78 s → B 111 s**, horse losses **52% → 6%**.
  Nothing in the roster moved for either case.

- **`flyTo` was the last entry point still parking the camera focus at sea level.** Its sibling was
  fixed in r1; this one still set the focus to y = 0 and let the next frame re-derive it from the
  terrain. It is the smaller fault of the two — there is no swoop, only a window in which the focus
  reads as sea level — and it has **no caller anywhere in the source, the tools, the viewer or the
  documentation**, which is exactly why it was worth closing before one exists.

- **The viewer's copy of the tone-and-grade shader is gone, not merely corrected.** It carried a
  hand-copied mirror of the post chain's two shader bodies and the copy had drifted: of the five
  uniforms they shared, film grain read **0.006** in the shipping chain and **0.016** in the mirror
  — and 0.016 is the level measured to leave **0.00% of a plate reading as a smooth gradient**
  against a Rome II reference of 7.09%, which a blind grader named as its single strongest scalar
  without knowing what it was looking at. The numbers were corrected by hand in an earlier pass and
  the mirror was left in place, which is the wrong fix: a copy that can drift eventually does, and
  nothing in the type system was ever going to notice. The shipping chain now exports both shader
  bodies, two uniform factories and the sample count, and the viewer imports them. One divergence
  survives on purpose and is documented at both ends — exposure is pinned at 1 against the shipping
  chain's sky-driven 1.42-5.1 — and it needs a sky to close.

### Corrections to the record

- **No archer stat was ever wrong, and the horse was never losing men on the way in.** The handover
  said a cavalry-versus-archers inversion meant the *sagittarii* were overtuned. Sliced band by band
  over the ten metres the horse is crossing, the charge arrives having lost **2 of 50 — the 4% the
  case is documented to produce** — both before the friendly-fire fix and after it. Three hundred
  arrows over 150 m of open ground buy one dead rider. Everything the archers gained happens *after*
  contact, and a nerf would have been tuning the one number in the case that was already right.
- **The 43% javelin refusal on Carthage is not a height fault and is not 43%.** The range bound
  genuinely was a level-ground figure compared against a horizontal distance, and it is now the
  launch solve's own discriminant envelope asked at the real height — but **the fix is measured
  inert**: attempts and refusals are 3,107 and 550 on both arms, and **no shot in 6,400 leaves
  without a ballistic root**, because every weapon's roster range is far inside its physical reach
  even at the 14.7 m Carthage's garrison stands above the ditch. A 24 m/s javelin's ceiling is
  29.4 m against a 13.4 m parapet, so "the discriminant goes negative and it fires at 45 degrees
  into the wall" cannot happen here. Sliced into eight thirty-second windows the refusal rate runs
  40.5 / 47.1 / 21.5 / 31.4 / 5.4 / 1.1 / 0 / 0% and pools to **17.7%**; **448 of the 550 refusals
  are more than twelve metres *below* the muzzle**, with 279 inside 1.1× of the bound and 211 more
  inside 1.25×. They are the garrison throwing down at men just past a horizontal bound at the
  moment a unit acquires a formation whose centre is at the edge of its range, and a refused shot
  costs no ammunition. It is a hold, not a fault.
- **Melee has never credited a kill to the wrong side, and that is now measured rather than
  argued.** Wrapping the damage entry point in the page over the Rome assault, the Carthage assault
  and the Campus Martius — 662 seconds — records **2,781 lethal blows, 1,889 of them melee, and not
  one same-faction credit**; the only uncredited deaths are the 46 the missile path deliberately
  gives to nobody. Kills against bodies: Rome 618/699 and 589/612, Carthage 294/309 and 491/493.
  The refusal is enforced at source now, with a counter, so it stays checkable rather than folklore.
- **Never compare two whole-suite runs of the matchup harness.** Run case by case with the two arms
  alternating in one session, **20 of the 22 cases come back byte-identical** across a real change —
  same winner, same second, same losses, same melee peak and mean. Run as two whole suites an hour
  apart at different machine loads and **four cases flip winner on an unchanged tree**, all four
  near-even by construction, because the winner is whichever side breaks first and a few extra
  frames between round-trips decide it. The documented ±8% is not a tolerance band; it is that,
  arriving as a discrete outcome.
- **Every isolated-model plate this project has graded was lit by something the game does not
  ship** — see the battle rig above. The deck that found the inside-out normals, the culled box
  faces and the reversed shield boss was right about all three; the finding is that its *light* was
  never the product's, and shadow-, roughness- or metal-dependent calls made on that deck should be
  re-read with that in mind.
- **A unit class is a simulation fact and a render path is not derivable from it.** The horse the
  viewer drew where the elephant should be came straight from `isCavalry`, which is true of
  `war-elephants` for good simulation reasons. Anything else keyed off that predicate should be
  read again.
- Two entries in the working notes that said "still open" were not: the viewer had been given the
  real lighting system, and the mirrored shader had been deleted. A stale "still not done" is worse
  than no note, because the next person spends an hour re-deriving a map that has already been
  walked.

---

## r4 — the frame stops hitching, and there is a way through every tower

**7 August 2026** · commit [`0a42909`](https://github.com/eoinest/Total-Claude/commit/0a42909) ·
deployment `total-claude-ll0g412dr`

A performance and siege-traversal release. The stutter people were feeling turned out not to be the
game being slow, men can finally walk past a wall tower, and archers on the parapet stopped shooting
into their own battlements.

### New

- **A doorway through every tower.** The owner: *"soldiers cannot walk past the towers."* Around is
  not available and the arithmetic says so — Rome's tower is 7.6 m along the wall and 9.5 m deep on
  a 6.0 m curtain, Carthage's 11.0 m and 14.6 m deep, and both are flush with the inner face by
  construction. So the walk goes *through*, which is what a mural tower has a chamber for.
  **Carthage had no opening at all**: `buildPunicTower` took a `walkY` argument and ended
  `void walkY;` — one solid 20 m prism, thirty-one of them, clear lane **0.00 m at every single
  tower**. Rome's opening was a stale constant sized for a 3.5 m curtain that had been 6.0 m for two
  workstreams, and the path walked men along the cityward lip 1.36 m past the far jamb: inside
  masonry at 42 of Rome's 42 walkable towers and 31 of 31 on Carthage.

  | | before | after |
  |---|---|---|
  | Rome, clear lane | 1.59 m median | **3.22 m median, 2.40 m worst** |
  | Carthage, clear lane | 0.00 m at all 31 | **5.72 m median, 5.54 m worst** |
  | headroom over the path | — | 2.0 m (Rome) / 2.2 m (Carthage) |
  | path inside masonry | 42/42 and 31/31 | **0/25 and 0/31** |

  | before | after |
  |---|---|
  | ![A tower on the Aurelian Wall as an unbroken brick block, with a file of legionaries backed up along the walkway beside it](docs/images/releases/r4-tower-rome-before.jpg) | ![The same tower with its chamber open at walk level — a doorway in the near face and the lit steps inside it, with a man on them](docs/images/releases/r4-tower-rome-after.jpg) |
  | The same tower at the same camera, one arm without the cut. The face is unbroken and the file stops at it. | With the cut: the chamber is open at walk level and the men go into it. |

  ![A cohort strung out along Carthage's parapet, filing past a mural tower with dark openings in its flanks](docs/images/releases/r4-tower-carthage.jpg)

  Carthage's parapet after the cut — where `buildPunicTower` had ended `void walkY;` and all
  thirty-one towers were one solid prism.

- **Quality adapts to your machine, not to a guess about your machine.** The old system was four
  fixed presets whose only resolution lever was `min(devicePixelRatio, tier.maxPixelRatio)` — on a
  non-retina laptop that resolved to 1.0 at every tier and did nothing at all, and a machine that
  could not hold 60 fps simply never did. Now a 90-frame p90 of the render half of the frame moves
  one pressure scalar: pressure 0 is exactly the tier you picked, pressure 1 is that tier's floor.
  Ultra on a weak machine is a slow ultra, not a silent demotion to low.
- **Anyone may climb a ladder, and a siege tower goes where it is sent.** Ascent from the storming
  side did not exist — a right-click on an enemy parapet was read, understood and discarded — and
  only the party that raised a machine could climb it, so a cohort standing at the foot of a ladder
  its own army had planted could not set a boot on it.

### Fixed

- **The game hitched, and it was not because it was slow.** On an idle box Carthage at ultra runs at
  a median frame time of **2.60 ms** (p99 7.00). Over 2,299 frames of the heaviest scenario in the
  game, **exactly four frames missed the 16.7 ms budget, all four linked a shader program, and there
  were exactly four link frames** — no false positives, no misses. three.js links a program the
  first frame a material is actually drawn, and nothing in the tree called `compile` or
  `compileAsync`; on ANGLE-over-Metal that link is a synchronous 40-290 ms on the main thread. It is
  triggered by the camera bringing something into view for the first time rather than by the
  fighting getting heavy, and the program count was still climbing at t+88 s, so a player who panned
  somewhere new twenty minutes in still paid. It is also amplified: a 151 ms stall fills the
  fixed-timestep accumulator, so the next frame fires all five ticks and costs another 30-38 ms —
  one link is felt as two bad frames. Programs are now linked on the loading screen. Carthage, 24 s
  of hard panning per arm: **programs linked during play 22 → 5, worst frame of the session
  583.7 → 73.0 ms.** It costs 0.3-2.8 s of load, which is why the loader now shows a *shaders*
  step rather than appearing to hang at 100%. Rome gains much less (worst frame 588 → 553 ms)
  because it links 27 programs against Carthage's 44, and that is reported rather than explained.
- **A man on the wall now shoots through the embrasure instead of into his own merlon.** The player:
  *"the soldiers on the walls cannot throw spears / shoot over the edge of the wall. It gets stuck on
  the little pieces of cover facing the enemies."* He named the object. Rome's parapet is 1.7 m of
  merlon on 0.95 m of gap, so **64% of the run is tooth**, and a man loosing from wherever he
  happened to stand shot his own battlement about two thirds of the time — *inside* the stone, not
  grazing it. The front rank stands 1.32 m in from the outer face and releases 0.60 m below the
  crest, so even at the lofted angle the shaft is still under the merlon's top when it reaches the
  far side of the tooth; clearing it over the top would need 55 degrees, and elevation alone could
  never have fixed it. The front rank now looses from the mouth of a gap, which is what a wall has
  teeth for; a rear rank, who cannot reach one, gets an elevation floor that clears the merlon's
  inner top edge. Incoming fire still stops on the crest — the player ruled pass-through out, and
  every field battle is byte-identical because the floor is `-Infinity` for anyone not on a parapet.

  ![The Aurelian Wall's parapet from outside: men of the garrison standing in the embrasures, one to each gap, with shafts across the openings between the merlons](docs/images/releases/r4-merlon-embrasure.jpg)

  The front rank in the mouths of the gaps, which is what a wall has teeth for.
- **The collision model's battlement was never the one that was built.** The model restated the
  crenellation as merlons on a fixed period starting at t = 0; the builder fits a whole number of
  merlons to the run and rescales, then centres each one in its own step. Rome's built step is
  2.7308 m against a nominal 2.65, with a half-gap lead-in, so the model drifted 0.08 m per period
  and was a whole merlon out of register by the far end of a bay — agreeing with the actual stone on
  **36% of Rome's parapet, worse than a random phase**. Arrows were stopping in mid-air over
  embrasures and passing through solid merlons.
- **The first tick of every battle deleted nine wall stairs from the collision set.** `Siege.armGate`
  deliberately toggles the gate open-then-shut on tick 1, and each toggle re-cut the wall obstacles —
  re-emitting only the boxes derived from the curtain, and silently dropping everything else marked
  as wall. The stairs are marked as wall. Rome went from 56 wall boxes and 9 stair boxes to 47 and
  **0**, Carthage from 160 and 13 to 147 and **0**, *before a man had moved* — nine flights on Rome
  and thirteen on Carthage, 14.2-20.4 m of masonry apiece and the longest solids in the city,
  non-solid for the rest of every battle. On Carthage it was worse than the stairs: the stair box was
  the only thing standing across seven of the eight postern gaps, so losing it opened seven 6.2 m
  holes in a wall that is drawn solid.
- **Eight posterns were holes in Carthage's collision surface and in nothing else.** The player:
  *"it appears that units can just pass through the walls."* Carthage publishes eight posterns as
  already-open gates, and the city cut a carriageway through the collision raster for each — but the
  builder only set a pierced arch *panel* into each face and never cut the wall's own skins. The
  passage is now refused where the stone is solid.

  ![Square on to a postern in Carthage's main wall from outside: a flat expanse of coursed ashlar with a chamfered plinth along the bottom, and set into it an arch about 10 m wide drawn as a raised ring of voussoirs with a straight jamb line dropping from each springing — and the wall's own coursing running straight through the middle of the arch, course for course, at the same brightness, with no opening, no shadow and no barrel vault behind it](docs/images/releases/r4-postern-face.jpg)

  Postern-29 as r4 ships it, in raking light. The arch is a relief on a solid wall — and the
  collision raster had a 6 m carriageway cut through it.
- **A war elephant left the instance buffer on the tick it died.** The owner: *"when they die they
  just disappear"* — and that is exactly what the buffer said. Elephant instances went 16 → 0 and the
  mesh invisible on the first frame after the killing blow, taking 64 soldier instances (four crew
  apiece) with them, with no recovery for the rest of the battle.

  | alive | t+260 s |
  |---|---|
  | ![Four Carthaginian war elephants advancing in line, each with a crewed fighting tower on its back](docs/images/releases/r4-elephant-alive.jpg) | ![One elephant dead on its side in the grass, its tower canted over beside it and its crew scattered around it](docs/images/releases/r4-elephant-dead.jpg) |
  | Four elephants under way, four crew apiece in the towers. | The same animal after the killing blow. It used to leave the instance buffer on that tick, crew and all. |
- **A broken party at the head of a ladder blocked everyone behind it.** The muster layout and the
  admission test used different rules about who belongs in a boarding file, so a routed escalade
  party went on holding the first fifteen rows at the foot of its own ladders while refusing to climb
  them, and the cohort the player had sent was laid out behind it — **14.6 m from a mouth with a
  1.6 m admission radius**, frozen there for the rest of the battle. Nearest man to the mouth
  14.6 → 0.4 m, peak on the parapet 0 → 26. This is the same defect that broke wall descent in r3,
  wearing different clothes: a place in a file handed to a man who is never going to use it.
- **A click on a defended parapet meant the wall, not the man behind it.** A garrison covers its own
  curtain, so from the field almost every pixel of an enemy wall has a defender behind it and almost
  every right-click on the masonry went out as an attack order. You cannot melee a man eight metres
  above you.
- **The performance readout said 111 fps through a stutter**, because it reported the median of a
  48-frame ring and discarded every frame over 333 ms rather than recording it. The one number the
  instrument could not show was the one the complaint was about. It now reports p99, worst frame and
  stall count: the same six seconds that displayed "9.0 ms/f 111 fps" reads 23.9 ms/f, 42 fps, p99
  85.3, worst 216.5, 2 stalls.
- **The first quality-tier switch crashed with a stack overflow**, through the event bus's deferred
  re-entrant drain rather than through the emit itself, so no re-entrancy flag could see it. Grass
  also read its density once at init and never again, so the largest lever on the frame never heard
  a tier change.

### Faster

- A tier switch **rebuilt nineteen render targets at identical dimensions** — the whole post chain
  plus six bloom mips, destroyed and recreated on a switch that changed neither the drawing buffer
  nor the sample count.
- The cursor asked the wall which side a unit was on **four times a frame** through a linear scan
  over every station on the circuit; the answer cannot change inside one frame.

### Melee

- **A gladius line was fighting at 56% of its own frontage cap while a spear line fought at 100%.**
  Two adjacent lines of code used two different conventions for the acquisition and keep radii. A
  legionary line against a Germanic line settles at rank 0 **0.69 m**, rank 1 **1.23 m**, rank 2
  **1.69 m** — so at an acquisition radius of 1.35 m a gladius covered all of rank 0, 52% of rank 1
  and none of rank 2. Frontage is supposed to be the thing that decides how many men fight; for a
  sword unit, geometry was binding first.

  | unit | engaged / cap | |
  |---|---|---|
  | urban cohort (spear, reach 2.4) | 49.9 / 50 | 100% |
  | legionary cohort (gladius, reach 1.1) | 19.5 / 35 | **56%** |

  After: kills per minute 81 → 94 and 79 → 93 in the two sword pairs, with the spear control
  unmoved, which is the point. What changes is *which* rank fights — rank 2 engagement 3.6 → 5.5
  and 7.3 → 10.9, rank 3 0 → 1.7. The value came from **Josh Kappler's PR #1**; the derivation and
  the measurement did not. **His stated case — that a gladius cannot touch the man it is shield to
  shield with — does not survive the arithmetic: that man is 0.84 m away and 1.35 m reached him
  fine. The real finding is the second and third ranks**, which is what a second rank is for.

### Corrections to the record

- **A reach change cannot move contact by 1.5×.** A proposed melee tempo multiplier was defended on
  the claim that the acquisition change above would move the number of men in contact enough to
  cancel it. Three instruments on pinned worktrees, both arms, say it does not: `peakFight` is
  *identical* on both arms in every real line engagement, because the per-unit frontage ceiling is
  hard and an acquisition radius cannot raise it — it only decides how much of the time a unit sits
  at its ceiling.
- **Two contradictory chokepoint readings were both right, about two different walls.** r1 recorded
  0.063 m/s of lateral drift at the gate and 188 man-ticks per mille inside masonry; a later agent
  read 0.203 and 350.8 and was disbelieved as a regression. Unmodified mainline reads 0.158 and
  372.9 — but the melee files are byte-identical across that span, so no melee code changed. The
  curtain went from 3.5 m to 6.0 m in between (r1), making the gate passage the probe measures
  through **71% longer**.

---

## r3 — a game you can play from the menu to the verdict

**7 August 2026** · commit [`6648aa8`](https://github.com/eoinest/Total-Claude/commit/6648aa8) ·
deployment `total-claude-khfh6dbxe`

The largest release of the cycle, and the one that closed the loop: deploy your army before the
fight, storm Carthage against actual Carthaginians, and be told who won. Sixty-three changes.

### New

- **A pre-battle deployment phase.** BEGIN BATTLE now hands you your army on the field with the
  clock stopped. Drag a unit to where it should stand and the drag sets its facing and its frontage;
  `Z X C V B` change formation; Delete takes a unit off; ADD UNITS opens the roster. **Drop a unit
  on the parapet and it mans the wall** — a 160-man cohort dropped on bay 15 stands at the bay's own
  published walk height with a worst vertical error of **0.000 m**, twelve metres above the terrain
  and nothing inside the masonry, in five ranks. Across all 45 garrisonable bays the clear standing
  band gives four to five ranks.

  ![The deployment phase with the interface up: a DEPLOYMENT bar across the top with ADD UNITS, REMOVE and BEGIN BATTLE, the clock at 00:00, sixteen Roman units laid out on the field behind the deployment line, and the card bar along the bottom](docs/images/releases/r3-deployment.jpg)

  Shown with the interface, because the interface is the feature.
- **Carthage is defended by Carthaginians.** An assault on Carthage used to deploy Roman
  *ballistarii* onto Carthage's wall and send Juthungi tribesmen up ladders at them: Rome 1,154 men,
  the Juthungi 1,920, Carthage **0**. There are now two Punic orders of battle. The 146 BC defence
  is the historical one — a citizen levy, freed slaves, engines re-framed out of temple timber and
  strung with the hair the women cut off, and nine hundred Roman deserters who could expect no mercy
  — because the 201 treaty forbade war elephants and the city surrendered its arms in 149. There is
  no moment in the Third Punic War with Carthaginian war elephants.

  ![The outer face of Carthage's main wall at t+101 s of the assault: a file of about ten Roman escalade troops in red tunics and bronze helmets climbing a scaling ladder nose to tail at the left, two more bare ladders further along, defenders standing in and behind the crenels across the top of the frame, Roman cavalry and a few men on foot on scorched ground at the wall's foot, and several dozen javelins frozen in flight against the masonry](docs/images/releases/r3-punic-garrison.jpg)

  Who is who is read off the unit table rather than off the picture: within 55 m of this focus the
  parapet holds `punic-levy` and `punic-freedmen` under faction 2, and the ladders and the ground
  hold `legio-escalade` and `equites` under faction 0. At 24 m a man is about 80 px, so what the
  frame shows is a Roman file on the ladder and a Punic crowd in the embrasures — not the kit.
- **An Enemy row in the menu**, and `?enemy=carthage` as a shareable link. The Punic *field* army —
  Sacred Band, Numidian horse, war elephants, seven bought contingents to one of citizens — had
  existed since Carthage was added and nothing anywhere set it, so every field battle drew the
  Juthungi and the Punic army could only be reached by hand-building a base64 battle token.

  ![The main menu, with rows for Battlefield, Battle, Enemy and Battle size. The Enemy row offers Juthungi and Qart-Hadasht, and Qart-Hadasht is selected; the order-of-battle panels below read ROME and QART-HADASHT](docs/images/releases/r3-enemy-menu.jpg)
- **An army that takes a wall goes down into the city.** The player: *"the enemy AI when on the wall
  kinda hangs out."* The larger half of the fix was a deletion: the siege system read *any* move
  order given to a garrison as "come down off the wall", which is right for a right-click and
  catastrophic for the AI's own march orders. Measured on the storm of Carthage with both armies on
  the AI, eight of ten wall units were carrying a descend goal at t+87, and the Carthaginian garrison
  fell from 448 men on the parapet to 69 by t+250 with the storm having cleared no bay at all. It did
  not die on the walk. The AI walked it off.
- **Right-click a parapet and the men go up it, and the cursor says so first.**
- **A face** — eyes with whites, irises and pupils, brows, a projecting nose, a moustache and a mouth
  line, on the one criterion that had scored zero in every blind round. A critic's exact words on
  that plate the round before: *"no eye, no eyelid, no eyebrow, no nose, no nostril, no lip, no mouth
  line."*

  | before — shot at r2 | after — shot at r3 |
  |---|---|
  | ![A legionary's head at high magnification under a bronze galea: crest block, bowl, brow band, cheek pieces, red focale and mail — and inside the face opening a smooth featureless pale oval with no eye, no brow, no nose and no mouth](docs/images/releases/r2-face-before-legio.jpg) | ![The same plate at r3: below the helmet rim a brown face with one fully legible eye — white sclera, dark iris, black pupil — a second eye at the edge of the face, a dark brow, a nose projecting as a wedge with its own cast shadow down the cheek, a moustache and a dark mouth line](docs/images/releases/r3-face-legio.jpg) |
  | ![A bare Juthungi head sealed inside one closed dome of straked hair that covers the cranium and the whole of the face past the brow, cut off by a hard horizontal edge with a thin dark slot below it, then chin and mail](docs/images/releases/r2-face-before-juth.jpg) | ![The same warrior at r3: fringed blond hair to the shoulders, two eyes with whites, irises and pupils, two dark brows, a nose projecting as a solid wedge with a nostril shadow under it, a dark moustache, a mouth line and a beard over the jaw](docs/images/releases/r3-face-juth.jpg) |
  | The critic's plate. The legionary's face opening is a blank oval and the Juthungi's face is sealed inside his own hair. | Both plates at each tree's own shipped framing. |

  Two honest notes on the pair. The **legionary** rows are the *same camera* — plate `legio-head`,
  az −0.6, el 0.06, fill 3.3, aimY 1.585 on both trees — but the pilum shaft and the *galea*'s two
  cheek pieces cover about a third of the r3 face, so it is a face you can read rather than a clean
  portrait. The **Juthungi** rows are not the same camera: r3 moved that plate from the man's
  right-front to his left-front (az −0.45 → +0.45) because with the azimuth convention finally
  correct his own javelin bundle stood between the lens and his nose. Both are three-quarter fronts
  of the same warrior; it is a mirror, not a turn.
- **Houses across Carthage.** Coverage 25.0 → **29.7%** of walled land and 36.6 → **51.5%** between
  street lines, with the dense city at 56.5% roof against the Punic cubit module's arithmetic ceiling
  of 60.9% — the fabric is at its ceiling, and raising the density knob would not move it.

  ![A measured plan of Carthage in 146 BC drawn from the built city rather than from the layout constants: the circular harbour and the merchant basin, the Byrsa, the triple wall across the isthmus, the named ways, and the housing blocks filling the quarters between them, with a section through the defensive belt below](docs/images/releases/r3-carthage-fabric.jpg)

  Plate 4 of 4, drawn from the *built* city — `getObstacles()`, `getLanes()`, `getCircuitSamples()`
  and `TerrainSystem.heightAt()` — rather than from the layout constants, so it can disagree with
  the design. The four plates are in [`plans/carthage-plan-v1/`](plans/carthage-plan-v1/).
- **One wall at Carthage, and a gate the ram can visibly break.** The landward belt was three
  parallel crenellated lines, only the innermost of which could be garrisoned or stormed, so a player
  could not tell which one his men would fight on. The 20 × 6 m ditch stays, moved back onto the main
  wall's own glacis — it is a cut in the heightfield, so zero triangles and zero draw calls, and
  nobody mistakes a hole in the ground for the wall behind it.

  ![A long stretch of Carthage's single curtain seen obliquely from outside with a square tower at each end: the whole length of the parapet lined shoulder to shoulder with defenders, spears up; five scaling ladders leaning against the face; a squadron of Roman cavalry drawn up in about five ranks under a standard on the open ground at the left; and behind the wall the city with umbrella pines, a cypress, tiled roofs and paved streets](docs/images/releases/r3-carthage-assault.jpg)

  One line, garrisoned along its whole length, with the ladders against it — and no second and third
  crenellated wall behind it for a player to wonder about.

### Fixed

- **Neither battle could be won, and the field froze for sixteen minutes.** Real fighting from t+100
  to t+1000 ground Rome from 3,772 men to 1,610 — and then nothing: identical numbers at t+1200,
  t+1300 and t+1500, 1,141 Romans against 3,951 Juthungi, not one man dying, until the 2,400-second
  clock fired. Sixteen and a half real minutes of a frozen scoreboard before the game admitted it was
  over. The collapse test only ever compared a side against *itself*, so 1,141 men — thirty per cent
  of Rome's own establishment — read as an army still in the fight with three and a half times as
  many stood opposite.
- **Eighteen units stopped attacking and the order book was sure it had told them.** The order book
  de-duplicates against what it last *said*, and the simulation writes a unit's order behind its
  back: an arriving move settles to Hold, a move that runs out of route settles to Hold, and an
  attack whose target dies is put on Hold at its own feet. None of those reached the book, so it went
  on believing the unit was moving and suppressed the identical instruction the behaviour layer kept
  issuing.
- **Wall descent, on the owner's fourth report.** *"The units on the walls are still stuck there."*
  The order was reaching the wall — a right-click 60 m into the city produced a descend goal on tick
  1, every time — but nobody could get to a stair. The queue layout was handed the unit's running
  count of **every man in motion** as a given man's place in *that* file: men already on a crossing,
  men queued at a *different* doorway, men bound for the far end of the curtain. So the head of a
  file stood back by however many of his mates were busy elsewhere, and it is self-reinforcing —
  every man who gets onto the path pushes the next one further out. Measured live on a 53-man cohort:
  twelve men crossed and the tally froze, after which the nearest waiting man of the remaining
  forty-one sat **2.26 m from a 2.00 m admission radius** and was still there ninety seconds later,
  with no plan timeout and nothing wrong with the geometry. The queue had been laid out beyond its
  own doorway. After the fix, at t+140 **43 of 44 living men are standing on the terrain inside the
  city**, 5.7 m below where they started; at the t+90 checkpoint, 10 men down before, 32 after.
- **Every soldier's face was inside out** — and the fix that went before it had pointed the camera at
  the back of his head. The lathe derives its outward normal only while y *descends* the point list.
  Every other lathe on the man is written crown-first; the skull profile was written **jaw-first**,
  so its normals pointed into the head, the winding followed, and front-face culling removed the near
  half of every man's face. A camera in front of a man saw *through* his face to the inside of the
  back of his skull, and every helmet bowl, hair dome and beard between the two won the depth test.
  Visible face pixels at the shipped framing: **580 → 157,649** on the Juthungi head plate and
  744 → 84,782 on the legionary. Three more full revolutions fell out of the same audit — the beard
  was a 360-degree hoop at mouth height, so 82% of Germanics and 42% of Romans had no mouth; the
  spangenhelm brow band was a complete turn, also at mouth height; and the fur cap was a full
  revolution, so a capped Juthungi measured exactly **0 face pixels**. The nose now projects 25.8 mm
  against a life-size 25, up from 14.
- **You could not click the men on the wall.** The pick was anchored to the ground *under* a unit
  rather than to the level its men are drawn on. With the camera on the field side, clicking the
  parapet crowd at its own screen position selected nothing, while clicking the same ground point —
  inside the masonry — selected it instantly.
- **The screen that announces the outcome could be seen through, and not dismissed.** The panel was
  never opaque, and no amount of opacity would have been enough, because the top bar, the minimap,
  the banners and the card bar are *siblings* in the same layer rather than things behind it.

  | before | after |
  |---|---|
  | ![The VICTORY panel with the top plaque, the banners and the card bar showing straight through it](docs/images/releases/r3-results-before.jpg) | ![The same panel opaque on a plain dark field, with a close button in the corner and a DISMISS button at the foot](docs/images/releases/r3-results-after.jpg) |
  | Before: the plaque, the banners and the card bar read straight through the panel. | After: opaque, with a way out of it. |
- **Nine dead cohorts kept their cards while the plaque said seven units** — two counts of the same
  army on one screen, disagreeing. Routed units keep their cards, because a broken cohort is still
  yours and can still be rallied.
- **Dust made things plain hard to see.** The owner: *"reduce the amount of dust kicked up, it is
  like making things just plain hard to see."* The emitter tapered against the *fraction* of the
  particle ring that was alive — but the ring is a memory decision, 5,000 slots at low and 22,000 at
  ultra, so **ultra drew 4.4× the dust it was tuned for**. Measured at the melee camera by hiding the
  particles at a paused instant and re-rendering the identical world: 58.1% of the frame had dust over
  it and soldier pixels were lifted 8.9/255, rising to 76.5% cover and +18.0/255 forty seconds later.

  | before | after |
  |---|---|
  | ![A wedge of Juthungi infantry seen from above, the far half of it washed out under a pale haze](docs/images/releases/r3-dust-melee-before.jpg) | ![The same formation with the haze gone: helmets, shield bosses and spear shafts legible right through the mass](docs/images/releases/r3-dust-melee-after.jpg) |
  | ![A cavalry unit mid-rout, completely erased by a white blob three times its own length](docs/images/releases/r3-dust-rout-before.jpg) | ![The same rout: two squadrons of horse plainly visible, with a thin plume where the fighting is](docs/images/releases/r3-dust-rout-after.jpg) |
  | Before, at ultra, where the ring is 22,000 slots. In the lower pair there is a cavalry unit under the white. | After. Both arms interleaved in one session at the same camera, with the base arm re-shot last as a drift check. |
- A cohort marched out through its own city wall, and the wall let it climb. A warband walked down
  into Rome and climbed straight back up the stairs. The ram opened a gate named `porta-flaminia`,
  and Carthage has no such gate. The top plaque said JUTHUNGI over a Carthaginian army. Carthage
  ended every battle with Rome's story, and its army counted NaN. A unit swapped for another kept its
  card and lost its selection.
- Carthage's geography: the Tophet of Salammbô sat 410 m from its own surveyed position, the merchant
  basin measured 84% land because its quay sample was taken at the basin centre, 22 houses and a
  tower stood in the lagoon, and the pathfinder called 110 hectares of Carthage water because it was
  still using the Tiber's channel.

### Faster

- **The spatial hash was clearing 1.5 million cells a tick to bucket 8,632 men** — *from Josh
  Kappler's PR #1*. The rebuild cleared and prefix-summed the whole grid on every fixed step: at
  3.5 m cells over a 3 km field, **736k cells touched twice per tick**, several times the cost of
  bucketing the men themselves, and scaling with the size of the map rather than with the size of the
  army. Bound to the cell rectangle the armies actually occupy, the rebuild becomes proportional to
  the occupied region plus the headcount — and bit-identical to a whole-grid rebuild, verified hash
  for hash against five determinism checkpoints at 8,632 men. That is what pays for the cell size
  going **3.5 m → 2.0 m**: the separation pass asks for everything within 0.84 m once per man per
  tick, and at 3.5 m that scanned about 37 candidates to find 6.
- **Carthage's assault camera went 242 → 200 draw calls while gaining 262 buildings**, twenty spare
  against the 220 cap, by taking the fabric from 99 chunks to 21 on one world lattice.
- **Medium quality was paying 94% of 4× MSAA's price for half the samples.** Eight camera
  measurements over two interleaved sessions: 4× against no MSAA is a median **1.18 ms**; 4× against
  2× is **0.07 ms**. The cost is in having a multisampled target at all, not in the sample count, so
  2× is the worst cell in the table and is gone.
- The assault frame was 55% shadow pass, and the city was casting one silhouette in six pieces.

### Also from Josh Kappler's PR #1

- The minimap compass turns the view, and points the right way.
- A middle-drag jumped the camera by however far the mouse had already travelled before the drag was
  recognised.
- The pick slack collapsed to 13 cm at close zoom, so precise clicks near the camera missed.
- Grass position, bearing, size and tint were all drawn from the same random number.
- The landmark key list was a hand-kept copy of the material table; the base rank spacing was three
  unrelated literals; and a HUD test that asks what is under the cursor instead of assuming.

### Corrections to the record

- **The metal rewrite had shipped half-applied.** A long note in the material table argues that a
  conductor has no diffuse lobe and that its colour is its measured F0, and the albedos were duly
  raised — but the metalness values were never moved. That left every metal a soldier wears **half
  dielectric with a metal's albedo**, which is the one combination that same note warns is worse than
  either end, and it is exactly what a bronze *squamata* photographed as: one smooth extruded gold
  ribbon with no seam between one scale and the next. Moving one half of a two-variable change and
  leaving the other is not the conservative choice; it is the worst point in the space.
- **Every torso was tiled 1.8:1 stretched.** The mail body ran three tiles around a 0.87 m
  circumference and four along a 0.65 m length — one tile covering 291 × 164 mm, so a 9 mm riveted
  ring rendered as a **16 × 9 mm oval** on every mailed man in the game, which is why a coif
  photographed as a sheet of embossed lozenges. The segmentata torso comes out unchanged at
  453 × 449 mm, which is the check that the correction is not inventing itself.
- **"No normal map, no roughness map" — named by three independent critics — was a starved sampler,
  not an absent one.** Both maps have been present for months. At the isolated-model deck's
  magnification one atlas texel was smeared over 2.0 to 4.7 screen pixels, so every surface was being
  magnified and read as bilinear mush. A starved sampler and a missing map look identical to an eye.
- **The soldier-quality ratio the project had been steering by measures the reference pool's upscale,
  not our models.** The Rome II reference crops are cut at 285×380 to 570×760 native and upscaled to
  900×1200; our plates are shot at 1800×2400 and resampled *down* to the same grid — a three- to
  six-fold relative resolution difference. Putting our own unchanged plates through the reference
  pool's own chain, with no model change at all, moves two of three of them into the reference band.

---

## r2 — Carthage becomes a place, and the soldier turns out to be inside out

**6 August 2026** · commit [`b7d8aaf`](https://github.com/eoinest/Total-Claude/commit/b7d8aaf) ·
deployment `total-claude-93652cjg7`

A second city and a second wall to storm, and a run of geometry defects on the soldier that no
battle frame could ever have shown. Forty changes.

### New

- **Carthage, 146 BC.** The isthmus between the Lake of Tunis salt pan and the Gulf — Appian gives it
  as twenty-five stades, about 4.6 km, so on a 2.8 km field the sea is off the edge on both flanks,
  which is what Scipio saw too. Then the triple wall from Appian *Punica* 95 at Attic measure, hollow
  throughout, with every dimension carrying the ancient figure it came from and the constants that
  have no ancient figure saying so. It satisfies Rome's stair contract unchanged, so the chunk baker,
  the occupancy raster, the obstacle set and all four siege accessors are the same code for both
  cities. Inside the walls: the Byrsa, the harbours, and a street fabric laid out on the archaeology's
  own 30 × 60 Punic cubit module — 15.5 × 31 m — so a Carthaginian street front comes out by
  construction rather than by taste. The defensive belt is 74.1 m deep with an enterable lower vault.

  ![The landward belt from the attacker's side of the isthmus: a low revetted outwork with a timber palisade along its crest, a taller crenellated middle wall behind it, and behind that the main wall with square four-storey towers under red-tiled roofs, with the pale city fabric and its pines beyond](docs/images/releases/r2-carthage-wall.jpg)

  Three lines in depth, and the ashlar courses and individual merlons both resolve. What is *not*
  in the picture is the ditch: `carthageWall.ts` publishes it as a request to whoever owns the
  heightfield rather than as geometry, and nothing in this tree cuts it, so the belt here is the
  54.1 m of built masonry and the glacis in front of it is flat.

  ![A near-aerial view east over Carthage: the Byrsa on stepped terraces with a walled summit precinct at the left, the rectangular merchant basin in the centre, the complete circular ring of the cothon's ship sheds around its admiralty island at the right, the insula grid filling the middle of the frame, and the wall belt across the bottom edge](docs/images/releases/r2-carthage-city.jpg)

  The Byrsa, both harbours and the grid. Read this as the **plan** and not as the density: there is
  bare ground between the quarters, and r3 is the release that fills them.
- **The wall is terrain.** The owner, three times: *"walls are like interactive terrain… when a unit
  leaves the wall they will walk down the stairs. Enemies on the wall can also walk down the stairs."*
  A unit on or near a wall now carries a plan with one of five goals — Hold, Ascend, Traverse,
  Descend, Storm. **Descent is the half that did not exist**: nothing in the simulation had ever taken
  a unit that was on the walkway and walked it down, which is why an enemy who took the wall stood on
  it for the rest of the battle.
- **Water is a map's to declare.** The owner played the new Carthage map: *"I see the ocean but no
  lagoon, it's just the beach."* He was right, and the lagoon was not the half of it — water was a
  ribbon of geometry built along the Tiber's own meander line, so the Tiber was the only thing in the
  engine that could render as water, and Carthage's gulf, lagoon and harbours all shipped as terrain.
  A flat desaturated plate with no specular, no animation and no depth cue reads as wet sand, and
  under a 20-degree April sun it reads as wet sand very convincingly.

  ![Low over the Gulf of Tunis into a 17:00 sun: a full-width specular track broken into thousands of individual wave facets running to the horizon, near-black navy in the shadowed foreground grading to silver-gold at distance, with the pale stone harbour mole and the city's sea wall along the top right](docs/images/releases/r2-carthage-water.jpg)

  The gulf, and **not** the lagoon: at r2 the Lake of Tunis is a 90 m channel between the shore
  scarp and the crown of the Taenia sand bar, and every framing of it photographs as a salt flat,
  because that is what most of it is.
- **A siege machine stops when its crew routs.** From a playtest: *"the ram gets routed and the people
  flee yet it keeps moving forward."* Fifteen tonnes of green timber is moved by a gang on levers and
  rollers; when the gang breaks it stops, and it stops in the open, which is the moment the defenders
  want. The siege tower had the identical hole.
- A belt, and a hand that is not a mitten. A `?map=` override, so a stored map choice is no longer
  inescapable.

### Fixed

- **56% of a soldier's triangles were shaded or wound inside-out.** The mesh builder wrote two
  independent descriptions of which way each surface faces — a per-vertex shading normal and a
  triangle order — and nothing tied them together: **2,347 of 4,175 triangles** on a legionary
  disagreed with themselves. The lathe emitted normals that were the exact negation of its own
  winding for every profile it was ever given, so every helmet bowl, the skull, the hair, all four
  shield bosses and every lathed weapon head drew correctly and then lit itself inside out — a bronze
  *galea* was sampling the ground hemisphere instead of the sky and rendering as a flat cream
  lampshade. The box primitive got a left-handed basis on four of six faces, so two of its sides were
  culled outright and a box drew as two facing panels with the world between them. Identical vertex
  and index counts after the fix, so it cost nothing.
- **The shield boss was modelled, tinted, paid for and drawn every frame — behind the board.** All
  four call sites passed a negative axial offset, so the scutum's umbo sat **219 mm behind** the face
  it should have stood proud of, the oval's 114 mm, the round's 56 mm. Sixty-four triangles a shield,
  invisible from every angle a player has. *"Flat discs, no boss geometry, no rim bevel"* was the cue
  both blind graders named first or second, and the one the cold grader said it could defend
  mechanically.
- **Every helmet was a closed dome over the eyes**, running below the brow and below both eye boxes,
  and the bare-headed men's hair was the same — every face sealed inside its own headgear. The Gallic
  shell was also radius 109 mm over a skull of 82 mm: **27 mm of padding all round**, against a real
  lining's eight or ten.

  ![An isolated legionary's head at high magnification: the galea bowl, the transverse crest seen end-on, the brow band, both cheek pieces standing clear of the face opening, the neck guard, a red focale and mail below — and inside the face opening a smooth featureless pale oval with no eye, no brow, no nose and no mouth](docs/images/releases/r2-face-before-legio.jpg)

  Shot from this release's own tree. The helmet bowl runs down over both eye boxes and the head is
  sealed inside it — which is also why the *galea* photographs as a flat cream lampshade: at
  `envMapIntensity: 2.9` a crown wound inside out samples the ground hemisphere instead of the sky.
- **Every closed ring in the game ran one column of its texture backwards.** A per-vertex modulo does
  not wrap the surface between two vertices — it runs the whole tile backwards, compressed into one
  column. Because rings close by reusing vertex zero, this happened even at a repeat of 1; on the mail
  and scale torsos, three of ten columns did it.
- **Nine wall stairs that nothing collided with.** Ground units walked through 10.5-13.9 m of masonry
  apiece, nine times over. The flight is a ramp rather than a wall, so boxing it whole would have been
  worse than the bug: the solid now starts where the rake is 1.2 m above its own foot — mid-thigh,
  the height at which stone stops being something to step onto — leaving the foot and the queue point
  behind it walkable.
- **The great roads ran 73-91% of their length through solid masonry.** The monument overlap resolver
  moves buildings a mean of 45 m *after* the streets are projected, and nothing ever re-ran the
  streets. The Via Appia lay 90% of its length inside masonry, the Via Triumphalis 91%, the Via Sacra
  81%, the Via Lata 73%, at zero clearance — which is why a cohort could march the whole military road
  and never get into the city.
- **Every map opened with "The Siege of Rome, 271 AD · Campus Martius."**
- **A click that never reached the wall**, so nobody could be ordered off it. The order plainly ran
  and the target never moved a centimetre, which cannot both be true of a click 62 m away: a
  garrison's anchor is *inside the curtain's footprint*, so the "don't walk into a wall" guard
  computed a clear line of zero and pinned every order to the unit's own feet.
- **The scorpio's claw and trigger were 2% of its pixels**, which is why five successive rounds of
  critics reported them missing on parts that were modelled and correctly placed the whole time. The
  whole slider group — bed, groove ribs, claw, trigger — measured 1.27% to 2.99% of the machine's own
  pixels across six views, against 32-48% for the body.
- **Film grain at 0.016 left no smooth region anywhere in the frame** — the adversarial grader's
  single strongest scalar. Switching only that one uniform: 0.016 → **0.00%** of tiles reading as
  smooth, 0.006 → **2.21%**, 0 → 69.67%, against Rome II soldier crops at a mean of 7.09%. It ships
  at 0.006.
- The cloth weave sat at four screen pixels, which is the worst place for it. The *galea*'s cheek
  pieces stood 33 mm clear of the face.

### Corrections to the record

- **"Twenty-three rounds, twenty-three separations" was quoted in every workstream's brief, and it is
  not a defensible claim.** Audited frame by frame. The good news first: **the HUD did not corrupt the
  record** — a detector calibrated on a known HUD-bearing pass scores that pass at 0.837% of frame and
  all nineteen surviving decks at **0.000%**, so twenty decks are clean by measurement rather than by
  assertion. But the denominator is wrong in three ways and all three inflate it. Nine of the nineteen
  graded our renders against *photographs*, which separate on sensor noise and depth of field whatever
  the renderer does. Ten decks came from **seven distinct shot passes** — three of them are three
  seeds of the same eight frames, three more are three seeds of the same six — and reshuffling a deck
  measures grader consistency, not the renderer. And no ledger has ever existed: about nine deck
  directories were deleted by their owners under the screenshot-cleanup rule and cannot be audited at
  all, one of them a lighting deck independently known to be void. **The honest statement is seven or
  eight independent render-quality passes against the Rome II plates, every auditable one of which
  separated, plus one known void round and about nine rounds with no surviving evidence either way.**
  Still a real and consistent result — no workstream has reached parity — and a seventh of the weight
  the old number implied.
- **Every blind deck ever built was graded on a 1.25× upscale**, leaving a period-4.995 resampling
  comb an adversarial grader read straight out of the files. It never sorted a deck, because it was
  applied to both sides, but every round to date measured pixel-scale energy on interpolated pixels.
- **Rome is not short of roof, and "20.5% built" was an instrument reading its own streets as
  failure.** The city audit built its street keep-out from the twenty-two named viae, 11 km, and could
  not see the further **374 lanes and 38 km** the district generator cuts — so every vicus in the city
  was scored as unbuilt ground, 39 hectares of carriageway counted as a gap. With the lanes in, the
  same unchanged city reads **roof between street lines 53.9 → 68.7%**, inside the 60-70% the AGEA
  orthophoto gives for the historic core. The remaining difference from the orthophoto is grain, not
  coverage.
- **The 60 m pomerium was never violated; the probe was measuring past the end of the wall.** It
  sampled 30-54 m *beyond* the east end of the curtain against a frozen z-line with no masonry near
  it, and labelled the intrusions by nearest *centre* — the Castra Praetoria is 278 × 262 m, so its
  centre is 200 m from its own corner. Restricted to the wall's real span and labelled by containment:
  minimum **60.0 m** over 220 samples, zero intruders.

---

## r1 — two lines that actually fight, and a wall you can put an army on

**1 August 2026** · commit [`dd77a5f`](https://github.com/eoinest/Total-Claude/commit/dd77a5f) ·
deployment `total-claude-qmlvu94rh`

The first release in this changelog. Melee started working, the Aurelian Wall got wide enough to
garrison, and the renderer stopped taking one geometric sample per pixel.

*Four production deployments predate this one (30-31 July 2026). They were prebuilt uploads carrying
no source, so there is no way to tell which commit each contained, and no release has been cut for
them. See the note at the end of this file.*

### New

- **A 6 m curtain you can put an army on.** The player's four reports about the Aurelian Wall,
  measured rather than asserted. The curtain goes 3.5 → 6.0 m — the top of the Theodosian range, not
  an invention, and the width at which the *worst* bay still seats five ranks. The number that
  matters is the clear standing band: **1.57 m → 2.21-4.06 m**, which at the simulation's 0.72 m
  interlocking pitch is **four to six ranks instead of two**.
- **Stairs that run along the wall.** The old flight ran out of a tower's city face at right angles to
  the curtain, projecting into the pomerium — not a thing Roman engineers built, and it ejected men
  off the back. Nine masonry flights now climb *along* the inner face: 14.2-20.4 m along the wall
  against 3.28-3.79 m of projection, on 0.29 m risers and a 0.42 m going, with a 2.2 m landing at the
  head and a travertine apron at the foot. The cheek wall's coping rakes smoothly rather than stepping
  with the treads — three reviewers looking at three renders all reported "no parapet on the open
  side" while the builder was emitting 0.95 m of one, because a stepped pale line above a stepped rake
  reads as more treads. One unbroken diagonal is the whole cue.
- **Scaffolding on the inside.** Standards, ledgers, putlogs, plank lifts, ladders and the treadwheel
  crane are all on the city side now, and the crane's jib swings over the material yard instead of
  hanging its load out over the glacis. The scaffold used to be a free ladder for the Juthungi.

  ![The inner face of the Aurelian Wall from inside the city in raking light: a masonry stair flight climbing along the wall from a travertine apron to a landing at a tower, its cheek-wall coping running as one unbroken pale diagonal under the treads; the broad flat top of the curtain with merlons along the far edge; and to the left, timber scaffolding of standards, ledgers, putlogs and four plank lifts standing against the unfinished bays, with dressed stone stockpiled in the yard at its foot](docs/images/releases/r1-wall-stairs-scaffold.jpg)

  The three entries above in one frame: the width of the walking surface, a flight that climbs
  *along* the wall rather than out of it, and the scaffold on the city side. The unbroken diagonal
  under the treads is the whole cue — three reviewers reported "no parapet on the open side" while
  the builder was emitting 0.95 m of one, because a stepped pale line above a stepped rake reads as
  more treads. There is nobody standing on the wall in this shot, so it shows the band and does not
  measure it.
- **The gate starts shut**, and is modelled shut: vertical oak boarding on iron straps, harr-posts in
  bronze-lined sockets, a drawbar across both leaves, and the lunette above them filled in brick. Four
  rays down the carriageway stop on one flat plane, and a ray restarted inside runs 25 m out the far
  side — so what the ram opens is a road and not a recess.

  ![The Porta Flaminia straight on from outside, 24 m back on the gate's axis between its two drum towers: twin oak leaves shut on the centreline with vertical plank boarding, four iron straps to a leaf each carrying a row of square-headed nail bosses, a meeting stile down the middle, a threshold slab, and a brick archivolt ringed with travertine voussoirs; above the leaves the raised portcullis hangs as a curtain of vertical bars](docs/images/releases/r1-gate-shut.jpg)

  Shut, boarded and strapped. **Two things the entry names are not in this picture and the caption
  will not claim them**: the drawbar is modelled on the *city* face of the leaves, so from outside
  it is behind 220 mm of oak, and the bricked lunette is behind the raised portcullis, so what reads
  above the leaves is iron and not brick. The face is dark at every hour — Campus Martius runs
  declination −14 at latitude 41.9 N, so the sun's azimuth never crosses north of the east-west line
  and this face is in shade all day. Shot at noon for maximum sky fill it is no brighter.
- A blind-comparison deck of **ten independent trials** instead of one battle photographed ten times:
  no two frames sharing a follow target, two maps, hours 07:30 to 16:24 against the single 17:00 every
  earlier frame shared, and one frame at high rather than ultra.

### Fixed

- **Two units standing 1.67 m apart landed zero blows in sixty seconds.** Nothing in the tick closed a
  front-to-front gap once both units' orders were satisfied, and four separate mechanisms that look
  like they should each stopped short. There was no auto-engage system at all — the name was dead in
  six tools and resolved to nothing — so a player's unit on Hold had nothing to rescue it. Why the
  warband twitched and the Romans never did: a horde's front slot carries a bulge, so its foremost man
  stands about 2 m ahead of his own anchor and fell just inside his own acquire radius while the
  Romans fell just outside theirs. That is the "little fighting animation but nothing happening".

  | anchor gap | real gap | blows in 60 s |
  |---|---|---|
  | 3.5 m | 1.23 m | 10 → **841** |
  | 4.0 m | 1.67 m | 0 → **708-772** |
  | 5.0 m | 2.65 m | 0 → **710-793** |
  | 5.5-7.0 m | — | 0 → 0, bounded by design |

  ![Looking down into the contact line at t+89 s with 8,352 men alive: ordered Roman files in ridge helmets on the left, the Juthungi with mixed shield blazons, cloaks and bare heads on the right, and the two masses interpenetrating along a diagonal seam rather than standing apart](docs/images/releases/r1-melee.jpg)

  The two lines pressed together at t+89 s. The camera is over the crowd rather than in it, so what
  the frame shows is that the seam has closed — not the blows themselves, which are a counter and
  not a pixel.

- **The gate chokepoint.** Lateral drift per fighting man 0.202 → 0.063 m/s, rotation 3.86 → 2.41
  deg/s, wall crossings off the carriageway 28/158 → 2/179, unit spread at t+119 s
  43.9/43.7/135.7 → 12.2/17.2/25.6 m. *(These figures were taken against the 3.5 m curtain and do not
  compare with anything measured after the widening above — see r4.)*
- **Stragglers stranded behind the wall 94 → 30**, twenty-seven of them walking their unit's breadcrumb
  trail back; there was no such mechanism before.
- **`R` never made anyone run.** It flipped a UI latch that was only read at the *next* right-click, so
  a unit already marching ignored it entirely. It now issues a gait order: **1.55 → 3.383 m/s** with
  the destination preserved. (Run was never broken — measured run speed is 3.264 m/s against a nominal
  3.5, the shortfall being fatigue.)
- **Every camera jump started underground.** A jump parked the focus at sea level and then let it float
  up to terrain height at a damped rate, so on a 40 m ridge the eye was still 4 m low a quarter-second
  later and took about 0.8 s to settle. The battle opened on an upward swoop nobody asked for, and
  every graded screenshot in the project's history had been shot through a climbing camera.
- **Every siege engine fired a fletched arrow, twelve at a time.** The scene held exactly two
  projectile meshes over one geometry — a 19-triangle arrow — and every kind was instanced from it with
  only its length scaled, so a 26 kg onager stone was drawn as a 0.44 m fletched arrow and a lead sling
  bullet as a 0.10 m one. Now three geometries. Separately, the emitter fired once per *crewman* rather
  than once per machine: a scorpio battery of 12 crew serving 4 engines loosed twelve bolts.
- **The great roads ran through masonry** — see r2, where the same defect is described in full; the
  street deflection landed here.
- **The ground bounce had no colour and the sky fill was short a factor of π.** The Lambertian term
  that fills the lower hemisphere of the environment probe — half of everything a standing man's
  vertical surfaces are lit by — used a scalar ground albedo against a deliberately neutral sun, so the
  ground's own colour, the largest factor in a real bounce, was simply absent.
- **The warm/cool split was compared in the wrong colour space**, so the whole frame took the shadow
  tint.
- **Mainline had not booted for three commits.** A commit landed render code with four call sites
  against functions that were never staged alongside it, including an ESM binding error fatal at import
  — a white screen with no game object — and two further commits were then stacked on a tree that had
  never run. **The live site was never affected**: the Vercel build fails on an unresolved named import
  rather than shipping it. A typecheck is not proof of life.
- **The harness clock moved the battle far further than asked.** Two different clocks meant a
  microsecond step actually advanced the world about 0.13 s, so every probe that used a tiny step to
  hold the world still was differencing two frames five simulation ticks apart and calling the result a
  noise floor.

### Sharper

- **The world was rasterised at one sample per pixel.** Spears were staircased because nothing in the
  chain took more than one geometric sample: SMAA and FXAA are morphological and cannot recover a shaft
  thinner than a pixel, and neither does anything for an alpha-tested grass blade that either passes
  its test or vanishes. This adds MSAA on the scene target (0/2/4/4 by tier), alpha-to-coverage on the
  grass, **coverage-preserving mips** for the grass card, and anisotropy swept to the device maximum.
  The long-standing "grass draw-distance seam" — a hard straight line where the sward stopped — was a
  mip band, not the ring fade, which is why moving the ring fade never fixed it. Measured over ten
  graded frames at ultra: pixel-scale harshness 1.479 → 1.382, structural detail held, sub-pixel
  temporal instability down 4-10%, cost +1.1 ms.
- A helmet bowl at forty metres is a curved mirror a few pixels wide — specular filtering to match.

### Corrections to the record

- **"Soldiers render at 2-4% of display luminance" is retracted. It was a unit error, and it
  misdirected three rounds of work.** The instrument reports *display-linear* values, as its own header
  says: 0.0354 / 0.0316 / 0.0204 linear are **0.207 / 0.196 / 0.157 display**. A second independent
  instrument agrees at 0.1745 display for soldiers against 0.3126 for the ground — and that ~30% ground
  figure was display all along, so the original comparison was mixing two unit systems. Rome II plates
  measure 0.2957 display. **The true gap is about 1.4×, not 8-12×.** This is why three successive fixes
  each measured a real gain and each still felt like nothing: they were sized against a target eight
  times too far away, and a fix sized for 8× would wreck the frame. There *is* still something to fix —
  a quarter of soldier pixels sit below 0.059 display and the median is 0.125, genuinely bottom-heavy —
  but it should be sized for 1.4×. The colour space is now in the variable name.
- **The crowd is not short of variation, so "add more variation" was always the wrong fix.** Read
  straight off the uploaded instance buffers rather than recomputing what they ought to contain, one
  320-man cohort carries **57-59 distinct kit masks, 119 statures, 229 cadences, 314 of 320 distinct
  animation phases, 252 tunic colours and 248 metal values.** The variation is there and it does not
  reach the screen; that is a different defect.
- **Raising metalness *darkens* armour here** — verified twice. Under a sun-dominated rig with a weak
  probe, full metal trades a sunlit diffuse term for a dim blue sky reflection.
- The blind harness had been **writing the answer into the JPEG quantisation tables**, and could not
  tell a HUD-free deck from a careless one. It now refuses a deck rather than reminding people: three
  gates on provenance, overlay content and file invariants, any of which deletes the frames.

---

## Before r1

Four production deployments were made on 30 and 31 July 2026, before this changelog began. Each was a
prebuilt upload of the `dist/` directory carrying no source, so **there is no way to determine which
commit any of them contained** and no release has been cut for them. They are recorded here for
completeness:

| deployment | created |
|---|---|
| `total-claude-rf4mkbnh8` | 31 July 2026, 20:22 PDT |
| `total-claude-lic8kshpz` | 31 July 2026, 17:31 PDT |
| `total-claude-84yd2teh6` | 30 July 2026, 17:22 PDT |
| `total-claude-ervckl196` | 30 July 2026, 14:10 PDT |
