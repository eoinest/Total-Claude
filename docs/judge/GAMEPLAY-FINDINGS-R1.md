# Gameplay judge — round 1

Played on `e/docs/rome-fabric` @ `940383a` (the integration tree, 29 commits ahead of `main`),
with the judge rig on top at `f4be695`, src `0e659d472a58c8f2`. Everything below came from
booting through the front door, clicking BEGIN BATTLE, and giving orders with a mouse.
Reproductions are `tools/judge/*`, all of which assert.

A note on the tree, because it changes what the numbers mean: **`main` — what the live site
serves — does not have `1fb1a48`.** Played on `main`, Rome is lost at **t+102**; on the
integration tree, **t+120**. Every figure below is the integration tree unless it says otherwise.

---

## What is already good — stop spending effort here

1. **The HUD is Total War grade and I mean that literally.** Command panel with strength /
   morale / fatigue / kills / frontage, formation and ability buttons carrying their own key
   hints, a unit-card strip that stays legible at 12 units, an event feed with ×N coalescing
   and tone colour. `screenshots/judge/rome-4265438264/r-escalade-46.png`.
2. **Refusals, where they fire, are the best writing in the product.** *"No way along the wall
   to bay 5 — the walk is broken in between"* with a `refuse` cursor teaches the player the map
   in one sentence. More of this, everywhere.
3. **The deployment briefs state the real thresholds and import them from the arbiter**, so they
   cannot promise a rule the sim does not enforce. Both are correct today, including the
   besieger's, which used to tell Scipio to man a parapet he does not have.
4. **Performance is not a problem and should stop being measured.** 120 fps capped (vsync),
   2.3 ms/frame, 435 fps uncapped, 218 draw calls, 8.2 M triangles, 2,887 men. Front door to
   playable field in **4.3–6.1 s** on all three maps. Zero page errors and zero console errors
   across roughly forty battles.
5. **The result card is beautiful** and the roll of honour with per-unit survivors and HELD /
   ROUTED / DESTROYED is a genuinely good idea. Its problem is a sentence, not its design.
6. **TAKE COMMAND works.** `?replay=<token>&from=45` flips `mode` to `commanded` on the tick,
   the button is there and labelled, a unit selects, and an order given afterwards is obeyed —
   63 m in 40 s.
7. **The seed row is real.** Twelve seeds, twelve distinct t+30 state hashes. Asserted, because
   a decorative seed row would make "twelve seeds" one measurement repeated twelve times.

---

## The ranked findings

### P0-1 — FLAT. Neither siege is a siege. Both end at ~t+120, before any siege engine arrives.

| | Rome (I defend) | Carthage (I attack) |
|---|---|---|
| verdict | **Defeat / objective, 12 of 12 seeds** | **Victory / objective** |
| decided at | t+103–121, median **110** | t+130 |
| condition | **B (60 inside), 12 of 12** | **B (60 inside)** |
| gate opened | **0 of 12** (designed t+220) | no — 7–11 blows of 26 |
| bay breached | **0 of 12** (designed t+420) | n/a, no great ram |
| siege towers | — | all four `approach`, **crossed 0**, at the final tick |

Four siege towers, 320 men, roll at 0.42 m/s from 74–101 m: they need 176–240 s and the battle
is over at 130. The gate ram is on schedule and the schedule is 90 seconds too late. The great
ram's breach at t+420 has never happened in a battle that reached its own conclusion.

So of the three advertised ways into Rome, **two have never occurred in a completed battle**,
and the third — escalade — is over in 100 seconds. There is no choice between them because
only one is ever live. Everything the siege spends five minutes building is furniture.

*Repro:* `node tools/judge/jg-seeds.mjs --port=P --map=campus-martius --runs=12 --until=2400`

### P0-2 — FLAT. Carthage plays itself. Giving no orders at all costs two seconds.

| arm | orders I gave | verdict | at | my casualties |
|---|---|---|---|---|
| `--arm=passive` | **none** | Victory / objective | **t+130.2** | 316 |
| `--arm=commit` | tower re-aim + 3 cohorts through the gate | Victory / objective | **t+132.3** | 328 |

In 140 s of the passive arm, **1,911 orders crossed the bus and every one was `source: 'ai'`.
Zero were aimed at any of my twenty units.** The six line cohorts — 960 men, 51 % of my army —
read `gr160` at t+36 and `gr160` at t+152; they never move. Two squadrons of equites, the same.

This is the rubric's §3 test and it is the worst possible result: the player is a spectator, and
every other quality in the product is decoration on top of it.

*Repro:* `jg-carthage.mjs --arm=passive` vs `--arm=commit`; `jg-turnstile.mjs --map=carthage`

### P0-3 — BROKEN *and* FLAT. Both cities fall to men who are running away.

`BattleFlow.censusWall` (l.668–684) counts a man inside on three tests — right faction,
`elevated === 0`, alive. **There is no test on `UnitOrder.Rout`.**

- **Rome, t+200.9.** Every man in the count belongs to a routing unit: escalade parties 16, 17
  and 18, `order=5`, `morale=0`, rout timers 60–78 s, standing **154 to 201 m** inside the
  city — they have run the length of the Campus Martius. `0 formed vs 46 routing` in my
  reproduction of the census.
- **Carthage, t+132.4.** Units 21, 20, 18, all `legio-escalade`. Unit 21 broke on the parapet at
  `morale 0` with a 35 s rout timer, ran to **97 m** depth, and rallied at t+127 — five seconds
  before the end, by which time it had already put 43 of the 60 men across the line.

The deciding condition of both sieges is satisfied by a rout. The card then prints *"The Byrsa
is taken. The three streets are choked from the forum to the citadel gate."*

The mechanic is arguable — men fleeing into your city are in your city. The *sentences* are not,
and the *experience* is not: you lose Rome to three broken ladder parties running away from you.

*Repro:* `jg-whoisinside.mjs --port=P --map=campus-martius` and `--map=carthage`.
Caveat: my reproduction of the census reads 46 where the arbiter reads 60 on Rome (it excludes
`stage === 'gap'` bays). The *attribution* is unambiguous; the absolute count is ±14.

### P0-3b — THE DIAGNOSIS IS BACKWARDS. Condition A does not fire because the garrison is too **weak**.

The standing explanation is *"condition A never fires because the garrison is too strong"*, and
it is reserved as a balance question. I tested it by doing the obvious thing a player who wants
to survive does: the deployment says **12 of 20 units, 8,928 men free**, so I pressed ADD UNITS
and spent the slots. Nothing else — no hand placement, no orders, same seed.

| | shipped garrison | reinforced |
|---|---|---|
| garrison | 12 units, 1 154 men | **20 units, 1 894 men** |
| decided at | t+103–121 (12 of 12 seeds) | **t+249** |
| gate blows | 0–4 of 26 | **26 of 26, at t+226 — the gate opens** |
| peak `stormOnWall` | 123–145 | 104 |
| peak **`stormHolding`** | **0** | **58** |
| plaque, t+246 | never | **"55 men hold a stretch of ours — 3 s to clear it"** |

**Condition A fired.** Making the garrison *bigger* is what made it reachable, and the mechanism
is visible in the numbers: A requires the storm to stand still on a run, and the storm only
stands still when there is something to fight. Against the shipped thin garrison the escalade
crosses an undefended parapet and walks straight down the inside — `stormHolding` never leaves
zero because nobody stops to hold anything. Against a thick one it gets stuck on the walkway,
and getting stuck *is* holding.

So the explanation is inverted, and the inversion is worth more than the finding: the same
change — more garrison — **doubles the battle's length, opens the gate route for the first time
in anything I have played, and unlocks the win condition that has never fired.** All three of
the top-ranked problems in this document move together, and they move the way nobody expected.

I still lost, at t+249, by condition B. So Rome may well be unwinnable. But it is not
unwinnable for the stated reason.

*Repro:* `jg-tryhard.mjs --port=P --seed=4265438264`

### P1-4b — BROKEN. Reinforce your army and the game tells you that you have taken zero casualties.

Same run. The top bar's Roman loss figure read **`−0` at every one of thirteen samples across
267 seconds**, while the men count fell 1 894 → 1 621 and the arbiter recorded **244 casualties**.

```
t+21.3   ROME 1 886  −0      t+144.2  ROME 1 715  −0
t+82.6   ROME 1 762  −0      t+267.1  ROME 1 621  −0     arbiter: casualties {0: 244}
```

`TopBar.update` computes `Math.max(0, m.initialStrength[PLAYER_FACTION] - r)`, and
`model.ts` l.326 latches `initialStrength` behind `if (!this.labelled)` on the **first frame
that has any views** — which is the shipped 12 units, before the player has added anything.
`labelled` is never reset. So the baseline stays 1 154, the live count is larger, the
subtraction goes negative and the clamp prints zero for the rest of the battle.

It only appears if you use ADD UNITS, which is precisely what a player trying not to lose does.
The end-of-battle card is unaffected — it prefers the arbiter's own tally — so the lie is
confined to the number the player is watching *during* the fight, which is the worse place for
it. The same latch is the card's fallback path, so the card would inherit it if the tally were
ever absent.

### P0-4 — BROKEN. The result card contradicts its own numbers, 40 pixels apart.

`screenshots/judge/rome-4265438264/r-99-result.png`. One panel, read top to bottom:

> **DEFEAT** — by objective, the ground that mattered has been lost — 01:59 on the field
> ROME: committed 1 154 · surviving **1 037** · fallen **117 (10 %)** · units lost **1 of 12**
> THE GATE **Held at 85 % — 4 blows** · BREACHES IN THE CURTAIN **0**
> ON THE PARAPET AT THE END **2 storming · 869 holding**
> *"**The wall was carried.**"*
> ROLL OF HONOUR: **HELD · HELD · HELD · HELD · HELD**

869 of my men are standing on the wall against 2 of theirs, no gate went down, no bay came down,
every unit in the roll of honour held, 90 % of my army is alive — and the card says the wall was
carried. `wallBlock` (`src/ui/BattleFlow.ts` l.125) keys that sentence on `reason === 'objective'`
alone. That reason covers two conditions; the sentence names only condition A, which never fires.

This is the fourth time this project has shipped a card naming a condition that did not decide
the battle. The arbiter knows which one fired and does not publish it, so the card has to guess,
and it guesses wrong in the case that happens **100 % of the time**. Publishing the fired
condition from `finish()` is the fix, and it removes the whole class.

It is also the most demoralising loss a game can hand a player: *you lost, and every unit held.*

### P1-5 — FLAT. Condition A has never once been non-zero, and the cause is not balance.

`stormHolding` was **0 in every sample of every run** across twelve Rome seeds and three
Carthage arms — 23 consecutive samples on Carthage while `stormOnWall` peaked at **308**.

It is not that the garrison knocks the lodgement back; the number never leaves the floor. The
mechanism is in the AI's own doctrine: `WallDoctrine` rule 2, *"an enemy on the ground inside
the curtain — go down the stairs at him"*, deliberately outranks rule 3, *"walk the wall to
him"*, and says so — *"Clearing the last defender off a mile of curtain … is not what the player
asked for."* Measured consequence: **53 samples of storming units standing on the stone carrying
`goal=descend`, with zero player orders on the bus.** The parapet is a turnstile, not a place.

So the first sentence of both deployment briefs — *"take a stretch of parapet and hold 24 men on
it for 20 s"* — describes a thing the units' own doctrine forbids. Every individual sentence is
true and the emphasis is a lie.

*Repro:* `jg-turnstile.mjs --map=carthage --from=30 --to=140`

### P1-6 — BROKEN. A wall order the cursor offers is dropped in silence, and no plan is made.

Rome, seed 4265438264, t+41.7. Unit 4 (`ballistarii`, 108 men, `unitClass: missile-infantry`)
standing on bay 8. Hovering the walkway of each of the other 31 garrisonable bays, classified on
the **cursor**, which is the live signal:

| | cursor `wall` (offered) | cursor `refuse` | nothing |
|---|---|---|---|
| unit 4, on bay 8 (mid-wall) | **15** | 9 | 7 |
| unit 0, on bay 1 (west end) | **0** | 26 | 5 |

I then issued four of unit 4's fifteen *offered* orders — 407 m, 370 m, 37 m and 37 m:

```
unit 4 -> bay 19 (407 m): 60 s later x317.04 -> 317.04; closed 0 of 407 m
unit 4 -> bay 18 (370 m): 60 s later x317.04 -> 317;    closed 0 of 370 m
unit 4 -> bay  7 ( 37 m): 60 s later x317    -> 317;    closed 0 of  37 m
unit 4 -> bay  9 ( 37 m): 60 s later x317    -> 317;    closed 0 of  37 m
   wall state throughout: goal none -> none, destRun -1 -> -1, planAge -1 -> -1, stuck 0
```

**Zero metres on four of four, including to the bay next door.** `goal` never leaves `none` and
`planAge` stays `-1`, so no wall plan was ever created — the order did not merely fail, it was
never registered. A `legio-cohort` behaves the same: in the full playthrough, cohort 10 on bay 8
was given the hint *"Along the wall"* and moved **1.1 m in 30 s**.

This is precisely the failure `WallDoctrine`'s own comment says `escaladeOfferAt` exists to
prevent — *"so the AI cannot issue one the simulation drops in silence — the same predicate the
cursor draws itself from"*. The traverse cursor is not drawing itself from that predicate.

Two smaller things fall out of the same matrix, both real:

- **The shipped deployment strands a unit.** Bay 1 sits at x 58 and the next garrisonable bay is
  bay 5 at x 206; the walk between them is broken, `refuse` on 26 of 31 destinations. The game
  deploys `ballistarii` I there and it can never go anywhere for the whole battle.
- **A wall unit is offered nothing at all in its own city.** Seven points 20–180 m inside the
  curtain all read `groundValid: true` and all show cursor `default` with no order. A garrison
  that cannot be sent into its own streets has no answer to a break-in — which is the only way
  either city ever falls.

*Repro:* `jg-wallmatrix.mjs --port=P --seed=4265438264 --at=40`

### P1-6a — WITHDRAWN. "You cannot attack anything."

Recorded because a judge who cries wolf on the most basic verb in an RTS is worth less than no
judge. Across three sessions, every right-click aimed at an enemy produced `hoveredId: -1` and
the hint **"Move here"**, including with the selection confirmed. I was ready to call it P0.

It is wrong, and the control proved it wrong. Sweeping the pixels an enemy is *drawn on*, with a
unit of mine selected: cursor **`attack`**, hint **`"Attack Tribal Warband II"`**, order becomes
`AttackMove(3)`, **70 kills in 45 s**, target 351 → 278. 8 of 8 checks pass. The attack verb is
in good shape.

What survives is smaller and still worth fixing: **a unit's anchor is often not over its own
men.** My own `legio-cohort` in line answers on 40 of 64 pixels of its own bounding box; a
`juthungi-warband` answers on 7 of 28, and its box is 2280 × 1077 px — wider than the viewport.
Aiming at the computed centre of that unit picked a *different* unit. A human clicking a soldier
they can see is fine; a human clicking into a melee where two units overlap is not, and that is
exactly when the attack order is wanted.

### P1-7 — BROKEN. The replay refuses its own records.

Token taken from the **end card** of a Carthage assault, replayed on the same build, same
browser, same machine, minutes later:

```
[replay] this record was made by a different build: the armies differ before a tick has run
(pool; recorded 8ca295e0/b835cac3/0b2dc55e, here fa60a0ea/b835cac3/0b2dc55e)
```

Both **unit** hashes match to the bit. Only the **pool** hash differs, at t+0, before a tick has
run. The `.rp-badge` reads **DIVERGED** in red from the first frame and never says anything
else — including after TAKE COMMAND works perfectly, so a player who takes over a battle is
told the whole time that it is broken. `divergedAt` is `0`.

This is the only multiplayer feature that ships, and the shipping path through it — press
*Copy replay link*, open the link — puts a red error badge on screen every time.

*Repro:* `jg-replay.mjs --port=P --map=carthage --rec=90 --from=45`

### P1-7a — Pydna is the best battle in the game, and it proves the sieges are the problem.

Same rig, same seed, three arms:

| arm | orders I gave | verdict | at | Roman casualties |
|---|---|---|---|---|
| passive | **none** | **Defeat** / rout | t+336 | 1 152 (31 %) |
| play | praetorian reserve into the weakest cohort, two squadrons round the flank | **Victory** / rout | **t+1141** | 2 144 (57 %) |
| blunder | whole army forward at once with `F`, into the spear line | Defeat / rout | t+1141 | 2 144 (57 %) |

**Four orders turned a five-minute defeat into a nineteen-minute victory.** That is the §3 test
passing, and it is the only place in the product where it does. Both sieges reach the same
verdict at the same second whether the player exists or not; the field battle does not.

It also swings. The blunder arm's advantage line, in order:
`JUTHUNGI 13 % → 11 % → 9 % → 8 % → 4 % → **Evenly matched** → ROME 5 % → ROME 19 % → ROME 7 %`
— then Rome lost anyway. That is a dramatic arc with real reversals, and nothing in either siege
comes close to it.

Two notes for balance. **Blundering is punished less than passivity** — the whole army thrown
forward at once lasted 19 minutes and got Rome to a 19 % lead; doing nothing lost in 5. And the
back half is a grind: Rome's headcount sat unchanged at 2 056 for 100 s (t+606–688) and at 1 645
for another 60 s, with "The lines have met" repeating in the feed.

### P1-7b — BROKEN. In a field battle the second line of the top plaque is dead text.

Every one of ~120 samples across three 19-minute Pydna battles reads the same five words:
**"The lines are dressing"** — at t+25, and still at t+1140. The phase *label* cycles correctly
(The Advance → Missile Exchange → The Clash → The Rout → Aftermath); the *note* under it never
changes. `PHASE_UI` has a correct note authored for every phase — *"Ground is being closed"*,
*"Arrows and pila in the air"* — and **none of them is ever shown to anybody.**

One line, in `src/ui/TopBar.ts`:

```js
if (siege) { ... }
else if (this.lastSiege) { this.lastSiege = ''; setText(this.note, PHASE_UI[m.phase].note); }
```

In a field battle `siege` is always null and `lastSiege` is always `''`, so the `else if` never
runs. The note keeps whatever `attach` wrote — `PHASE_UI.deployment.note`. The guard was written
to avoid rewriting the note every tick and it removed the only path that ever writes it.

### P1-7c — BROKEN. Pydna's victory card names an enemy that cannot be in the battle.

`src/ui/BattleFlow.ts` l.87 and l.90, hardcoded per map:

> *"The field under Olocrus is Rome's. **Macedon** put her whole levy into one line…"*
> *"The legion could not get inside the points… the **pikes** are still coming on in step."*

I fought the Juthungi. There is no Macedonian roster in this game — the three factions are Rome,
Germanic and Carthage — so the only two opponents Pydna can field are Alemannic warbands and a
Punic host, and the card names a phalanx to both. This is the same defect as "JUTHUNGI advantage
25 %" printed over a Carthaginian army, which was fixed once already.

### P1-7d — FLAT. A field battle gets no brief at all.

`brief: null`. Both sieges get an excellent objective brief with the real thresholds imported
from the arbiter. The field battle — the map where the player's decisions actually decide it —
tells them nothing about how to win. And first contact at t+107 is announced nowhere: the plaque
still reads "Missile Exchange" while 64 men die, and *"The lines have met"* reaches the feed at
t+151, **44 seconds late**.

### P2-8 — FLAT. "In the Streets" while 98 men are on my parapet.

Rome t+72: `stormOnWall 98`, `stormInside 33`. The plaque reads **In the Streets** / *"31 of them
are past the curtain"* / *"31 of 60 inside — hold"*. `derivePhase` promotes `streets` above
`wall` on **one** man inside, so from the first man through, the escalade is named nowhere.

Nothing on the default HUD says *which* of my 32 bays is being climbed. There is no objectives
panel at all — my sweep for one returned empty. The enemy order of battle is behind `J`, which
is not on screen. The minimap at 1600×900 is ~190×130 px and shows a brown rectangle.

*Impression, not yet measured:* I could not tell from the frame where the fight was. What would
settle it: a probe that, at t+50, asks how many pixels of the viewport carry any marker
attributable to the contested bay.

### P2-9 — BROKEN. The siege-tower re-aim is not reachable by clicking a bay.

Selected `legio-tower-party` 14 on the **first click**, hovered a bay walk reading
`wallValid: true`, right-click-held: hint **"Move here"**, cursor `move`. None of the documented
machine vocabulary appeared, and the towers' positions afterwards changed only by their own
forward roll. Either the aim point for a machine order is somewhere a player would not guess, or
the offer is not being made — and the cursor saying `wall` on hover and `move` on press is
itself an inconsistency.

### P2-10 — process. The playability rig has never seen a battle end.

All six `tools/scratch/pl-*` scripts poll `.endcard, .result, .verdict, .battle-result,
.result-sheet, .outcome`. The panel the product renders is **`.rs-panel`** with `.rs-verdict`
(`src/ui/BattleFlow.ts` l.480). None of the six matches. `pl-runA` loops 24 × 25 s looking for
it. This is the same silent-no-assert failure the rig's own header warns about, one layer down —
and `pl-lib-emc.mjs:fast()` still advances at `166 ms`, which `Engine.advance`'s own comment says
is a different battle from `1000/60`. Any number that pass produced is off a run nothing can
reproduce.

---

## The one thing I would fix first

Not the card, and not the orders. **Make the battle last long enough for its own machinery to
arrive.** Every other finding here is downstream of a 110-second siege: the gate cannot matter
at t+220, the breach cannot matter at t+420, the towers cannot dock, the player's cohorts are
never needed, condition A cannot be reached because nobody is on the wall long enough, and the
card is wrong because the only condition that ever fires is the one it does not name.

Raising `BREAK_IN` is not the fix — it moves the number without changing the shape. The shape
changes when men inside the walls have to *stay* there: exclude routers from the break-in census,
and the sixty men who take Rome have to be sixty men still fighting.

### P2-11 — SPECTACLE. The moment that decides every Rome battle is two conga lines walking into a park.

Framed with `tools/film.mjs` rather than by projecting a unit anchor, because a scripted camera
pointed at a centroid is not a player's camera and grading spectacle off one would be unfair.
Shot script: `tools/judge/shots/judge-moments.shot.mjs`, cued on the events themselves
(`climbing(140)`, `routing(90)`, `melee(400)`). Frames in `screenshots/judge/moments/`.

- **`over-the-parapet-00090.jpg`** — t+28, 221 men climbing, 39 fighting. The Aurelian Wall in
  raking morning light with twelve ladders against it and the files on them legible as a shape.
  **This is the best the game looks and it is genuinely good.** But the men are 3–8 px tall and
  there is no close version of this moment: the walk is 34.5 m up and 7 m wide, so the only
  camera that frames the escalade frames it as landscape.
- **`the-break-in-00179.jpg`** — t+67, the moment that decides the battle. Behind the wall:
  **empty parkland.** Trees, grass, two isolated brick towers, and the city proper a distant
  band on the horizon. The men who take Rome come down the inside in **two dead-straight single
  files**, hundreds long, and walk into a void. Nothing is defended, nothing is fought over,
  nothing is reached. The card calls this "the ground that mattered".
  *My first attempt at this shot put the eye 70 m inside at eye 14 and ended up **inside the
  Pincian** — the hill behind the Muro Torto rises above the wall's own footing, which is worth
  knowing about the ground a break-in happens on.*
- **`the-clash-00179.jpg`** — Pydna, ~1,000 men in melee. The Pierian plain, Olympus in haze,
  evening light and dust. Handsome.

### P2-12 — FLAT. A Juthungi warband is four to eight times looser than a cohort, and stops reading as a body of men.

I looked at the clash frame and wrote down "the fighting line is one man deep, like a picket
fence". **That impression was half wrong and the measurement is better than the impression**, so
both are recorded. Extent of each unit's living men along and across its own facing, Pydna:

| unit | frontage | depth | density |
|---|---|---|---|
| `legio-cohort` at t+5 | 34.4 m | 7.1 m (≈10 ranks) | **1.30 men/m²** |
| `legio-cohort` in the melee, t+144 | 30.8 m | 5.5–8.4 m | **1.30–1.52 men/m²** |
| `juthungi-warband` at t+5 | 40.7 m | **29.1 m** | **0.303 men/m²** |
| `juthungi-warband` 19 at t+205 | 58.3 m | **41.1 m** | **0.150 men/m²** |

The Roman cohorts are a proper block and hold their ranks through the fight — that is good and
it is what the frame shows on the left. The warbands are not: 360 men spread over 2,400 m² is
one man per 6.7 m², about 2.6 m apart, and at any camera height that reads as scattered
individuals rather than a warband. Half of every field battle in this game is drawn as a crowd
leaving a stadium. Whether a Germanic host *should* fight loose is a design call; 0.15 men/m² is
not "loose", it is "not a formation".

*Repro:* `jg-ranks.mjs --port=P`

### P2-13 — the second shape baseline, and what it says about the seed.

Carthage assault, 8 seeds, hands-off, same tree:

```
outcomes           Victory/objective, 8 of 8
decided at         165.9-381.6   mean 249.3
contested window   133.8-349.4   mean 217.2
contact            32.03-32.20   mean 32.1     <-- 0.17 s of spread across eight seeds
my first break     42.30-42.47   mean 42.4     <-- 0.17 s of spread across eight seeds
advantage flips    0 0 0 0 0 0 0 0
```

**The first storming party breaks at t+42.4 on every seed, within a sixth of a second.** Rome's
twelve seeds put the first man on the parapet at t+52.3–52.6, the same. The seed changes who
dies; it does not change what happens or when. That is the strongest single statement I can make
about why the sieges do not bear replaying: they are not twelve battles, they are one battle
twelve times with different casualty lists.

---

## The incoming change: baseline, and the noise floor it has to clear

A change is landing that is expected to move survivors at t+200 on the default field battle by
about **2.6 %**, by flipping a small number of discrete decisions. Baseline captured *before* it
lands, at `f4be695` / src `0e659d472a58c8f2`, 2026-08-22T02:38Z: campus-martius field, 8 seeds,
hands-off, sampled every 10 s, with the product's own state hashes at ticks 900 / 2700 / 4500 /
6000 / 12000. Raw in `screenshots/judge/shape/shape-campus-martius-field-before.json`.

```
survivors at t+200   6784 6456 6671 6569 6986 6770 6559 6734   mean 6691.1   sd 165.5
contact              73.3-83.7                                  mean  78.4
my first break       93.8-134.9                                 mean 106.8
their first break    104.0-114.6                                mean 108.1
decided at           310.6-577.9                                mean 387.5   sd  85.4
contested window     237.0-504.5                                mean 309.1   sd  87.3
advantage flips      0 0 0 1 0 0 0 0
closest it ever got  0.011-0.137
outcomes             Defeat/rout, 8 of 8
```

**The arithmetic, stated before any after-data exists.** 2.6 % of 6 691 is **174 men**. The
seed-to-seed standard deviation at the same checkpoint is **165.5**, and the observed spread
between the best and worst seed is **530 men**. So the change is **1.05 σ of the noise a player
already meets every time they press reroll.** On the mean of 8 seeds it is a 3.0 σ effect and
will show up cleanly in aggregate; in *any single battle* it is arithmetically smaller than the
difference between two seeds. A player cannot perceive it as a magnitude. The only way it could
be perceptible is as a **change of shape** — battles that stop swinging, or stop being close, or
stop varying — which is what the columns above exist to detect and why they were recorded rather
than the survivor count alone.

**Two of my four pre-registered criteria are void on this arm and I am saying so rather than
quietly dropping them.** The hands-off field battle already produces one outcome (Defeat/rout,
8 of 8) and already produces zero advantage flips (7 of 8), so criteria 1 and 3 cannot fall
further and cannot discriminate. The discriminating statistics here are **contested window**
(sd 87 s), **decided-at** (sd 85 s) and **minGap**. Criteria 1 and 3 keep their force on the
*played* arm, where the outcome genuinely is two-valued — Pydna passive is a Defeat at t+336 and
Pydna played is a Victory at t+1141 — so that arm is where a real degradation would show.

A Carthage-assault baseline is being taken alongside, because the sieges are decided by 60 men
crossing a 14 m line and every crossing, admission radius and escalade reach is a distance
compared against a threshold — the densest concentration of exactly the discrete decisions this
change perturbs. The siege verdict is currently identical on 12 of 12 seeds, which makes it a
sensitive detector: if that uniformity breaks, the change is doing something.

**What I will do when it lands.** Re-run the identical campaigns, confirm from the state hashes
that the tree actually moved (if it did not, I will refuse to grade rather than grade noise),
and compare distribution against distribution. I will not compare seed 7 before with seed 7
after and call the difference a regression: if discrete decisions land differently then those
are simply two different battles, exactly as seed 7 and seed 8 are, and treating one as the
"corrupted" version of the other is the single easiest way to manufacture a false positive here.

---

## Addendum — the baseline set is complete on both trees, and it says one more thing

Six campaigns now: three on `main` (`mainbase`) and three on the integration tree (`before`),
each with the product's own state hashes at fixed ticks. Comparing them is not the grading job —
it is a positive control for `jg-compare.mjs` — but the control found a pattern worth reporting
on its own, because nobody was grading these 29 commits.

**Outcome variety fell on two of three campaigns and the third was already at one.**

| campaign | `main` | integration tree |
|---|---|---|
| campus-martius field | **{Victory/rout 2, Defeat/rout 6}** | **{Defeat/rout 8}** |
| carthage assault | **{Victory/objective 7, Victory/rout 1}** | **{Victory/objective 8}** |
| campus-martius assault | {Defeat/objective 12} | {Defeat/objective 12} |

Two of three moved toward a single outcome and none moved away from one. On its own each is a
seed or two flipping; together, in one direction, on a change nobody measured for it, it is a
pattern.

The field battle is the sharp case and the accompanying numbers are what make it a finding
rather than a shrug: Rome breaks **later** (`my first break` 93.99 → 106.77 s, **+13.6%**, beyond
its own spread) and the enemy breaks **earlier** (`their first break` 114.75 → 108.06 s,
**−5.8%**, beyond its own spread) — **and Rome wins less often.** Later break, earlier enemy
break, fewer wins. Those three do not sit together under a tuning drift.

The sieges moved the other way on length and in opposite directions from each other, which is
its own oddity: Rome's assault went **t+62.9 → t+116.8** (longer, better) while Carthage's went
**t+293 → t+249** and its contested window **263 → 217 s** (shorter). Both flagged "inside its
own spread" only because those columns carry an sd of ~150 s, so the spread cannot threshold
them — see MAP-METHOD rule 12; the percentages are the honest reading there, not the sigma.

**And the number that should not stay inside a comparison table.** On `main` — what the live site
serves — the Rome assault is decided at **t+62.9 on 12 of 12 seeds with sd 0.15 s.** The range is
63 to 63 seconds. The integration tree doubles it to t+116.8, which is the right direction and
still catastrophic.

---

## CORRECTION to P0-2/P0-3 — "both cities fall to men who are running away" was one city, and I sampled outside the window

Accepted, and worth scoping precisely rather than withdrawing wholesale, because two different
things are tangled in it.

**What I measured, and it stands.** Integration tree `940383a`, Rome, at **t+200.9**: of the men
in the deciding census, **every one** belonged to a unit at `order=5`, `morale=0`, rout timers
60–78 s, standing 154–201 m inside the city. That is a true statement about that tree.

**What was wrong.** I let the headline generalise to *both cities* without checking that the
window I sampled in existed on the tree that ships. **`main` ends that battle at t+56** — before
anybody has broken — so there are no routers to find, and the re-measurement finds **0 routing
men of 132** in the deciding census, identical before and after the fix.

**What survives.** Carthage, where the finding holds and the fix moves it: **t+130.8 → t+134.1**,
21 → 24 men excluded. And Rome on the integration tree, where the battle lasts long enough for the
escalade to break.

**The corrected sentence, which is the one to carry forward:** *Rome's siege on `main` is decided
at t+56, before anyone has broken, and routers are not the cause. Rome's siege on the integration
tree lasts long enough to be decided by routers. Carthage is decided by a mix of both and moves
3.3 s when they are excluded.* Any explanation of `main`'s t+56 has to look elsewhere — and the
same report says where it cannot look: gate never struck, `stormHolding` 0 in every sample,
decided by condition B.

### The rule this is an instance of, and it has three faces

**A checkpoint must lie inside the window in which the thing it measures exists, and that window
is a property of the tree and the map, not of the metric.** All three faces below returned a
confident number and none of them raised anything, which puts them in MAP-METHOD rule 12's
family.

1. **Sampling after the window closes, and noticing.** t+400 against a field battle whose median
   verdict is t+367: only 2 of 8 seeds are still being fought there. I caught this one and
   declined to grade it, and it is why the −18.2 % headline needs a caveat.
2. **Sampling after the window closes, and not noticing.** t+200.9 against a Rome siege that ends
   at t+56 on `main`. Same shape, opposite outcome: it produced a *true* finding about a tree where
   the window existed and a *false* generalisation to one where it did not. The tell I should have
   looked for was already in my own data — my `main` baseline says that battle is over at t+63.
3. **Sampling coarser than the window.** Mine, and it is in a number I made a headline of. See
   below.

### And my own third instance, in the sentence I put in front of the coordinator

I reported **"`main` decides the Rome siege at t+62.9 on 12 of 12 seeds with sd 0.15 s — a range
of 63 to 63 seconds."** The independent measurement is **55–58 s, median 56**.

`jg-shape` recorded `at = s.t`, the time of the *sample on which the result panel was first seen*,
and it samples every 10 s. So every verdict was up to 10 s late, and twelve seeds that truly
finish across a ~3 s spread all landed in one bucket and came out as **sd 0.15 s**. I then quoted
that sd as evidence the battle was identical on every seed.

**It was the sampling grid, not the battle.** The statistic did not lose its sample or its spread
— it lost its *resolution*, and returned a confident number anyway. Fixed to read the arbiter's
own `result.at`, with the sample time kept beside it as `seenAt` so the two can never be confused
again.

**What survives and what does not.** The *comparison* survives — both arms share the grid, so
before-vs-after is apples to apples. The *absolute claim* does not: the honest sentence is **"main
decides the Rome siege at t+56, on 12 of 12 seeds, with about three seconds between the fastest
and the slowest."** Still the most damning number available, and now the right one.

### Two instruments this correction explains

- **`qa-replay.mjs` records only `campus-martius / field / high / small`.** No siege record has
  ever been through it. That is why it reports 21/21 while every siege replay I ran showed
  **DIVERGED** — it is not a contradiction, it is a gate that never looks at the failing case.
  It is the third instrument this week that passes for that reason, after `--battle=rome` and the
  six playability scripts.
- **The pinned Carthage determinism arm cannot detect a break-in change**: that battle is still
  being fought at t+400 with 2,193 of 3,440 alive, so its checkpoints sit before the thing they
  would have to see. **Its silence is not evidence** — which is face 1 of the rule above, in a
  gate rather than in a probe.
