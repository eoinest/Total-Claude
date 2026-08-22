# The gameplay judge's rubric

Written before the findings, so it cannot be shaped to fit them. It is argued rather than
asserted: every criterion says what it is for and what evidence settles it, because a rubric
whose criteria cannot be settled is a taste, not a standard.

The standard this is measured against is the owner's: *testing agents are absolutely wowed by
gameplay*. So the bar is not "works". Ten of the twelve things below can be true and the game
can still be dull, and where that is the case this rubric says so out loud.

## 0. The two rules the rest depends on

**R0.1 — Separate broken from unsatisfying.** A bug has an owner and a fix. A design weakness
has an argument and a decision. Reporting one as the other wastes both. Every finding below is
labelled **BROKEN** or **FLAT**.

**R0.2 — An impression is not a measurement, and a measurement is not an experience.** Both are
admissible; neither may masquerade as the other. An impression is flagged as one, with the
measurement that would settle it named. A measurement with no experiential consequence is
noted and ranked low.

## 1. Is the battle *legible*? — weight 3

The player must be able to answer four questions at a glance, and the game must not answer any
of them falsely.

| question | settled by |
|---|---|
| Who is winning? | the top plaque's objective line against `battleFlow.objective`, sampled together |
| Which of my units is in trouble? | can I find the contested bay / breaking cohort from the default HUD alone, without the debug key |
| Was my order accepted? | the drag hint, and whether the unit then does it |
| Why did I lose? | the result card against `BattleFlow.result` and the census behind it |

**Honesty is graded hardest of anything in this document.** A screen whose own numbers refute
its own sentence is a P0 regardless of how handsome it is. This project has shipped that defect
three times and fixed it three times; a fourth is a process finding, not just a bug.

## 2. Do orders do what I meant? — weight 3

Split deliberately, because the three failure modes need different fixes:

- **Refused out loud** — acceptable, often *good*. "No way along the wall to bay 5 — the walk
  is broken in between" teaches the player the map.
- **Accepted and carried out** — the target.
- **Accepted silently and not carried out** — the worst outcome available, and ranked as such.
  The player cannot tell it from a slow order, so they cannot learn, so they stop trusting the
  whole verb.

Measured by: sweep the pixels a thing is drawn on, record what the cursor and hint promise,
issue the order, and watch for 40–60 s. Selection difficulty is itself a number
(`answering/probes`), because a unit that needs a pixel hunt is a unit the player cannot command.

## 3. Is there a decision, and does it have consequences? — weight 3

The test is brutal and it is the right one: **play the battle giving no orders at all, and
compare.** If the passive arm reaches the same verdict at the same time as the played arm, the
player is a spectator and every other quality in this document is decoration. Any map that
fails this is FLAT at the top of the ranking whatever else is true of it.

A real decision needs: two or more routes that are both live at the moment of choosing; a cost
that is legible before committing; and outcomes that differ.

## 4. Is it winnable and losable in interesting ways? — weight 2

Measured as a **distribution over seeds**, never one playthrough — an unwinnable battle and a
hard one look identical once. Per seed: verdict, reason, tick, and *which* condition fired.

- More than one outcome across the seed set, or the seed row is decoration.
- The advertised win conditions must be reachable in play, not merely in code. A condition
  named first in the deployment brief and never once non-zero in twenty runs is a **lie of
  emphasis**, which is a real fault even though every individual sentence is true.
- Defeat must be attributable. "You lost and every unit held" is not an explanation.

## 5. Pacing — weight 2

Not "how long", but "how long was it in doubt". Recorded as: time to contact, time to the first
break on each side, the **contested window** (contact → verdict), how many times the advantage
crosses sides, and how close it ever got. A battle decided at t+110 with zero lead changes is
worse than one decided at t+110 with three, and a survivor curve cannot tell them apart.

A siege whose machines arrive after the verdict is a pacing failure even if the verdict is fair.

## 6. Spectacle at the moments that matter — weight 2

Only at the four transitions: the gate going, a bay coming down, the parapet being topped,
cavalry into a flank. Judged on whether the moment is *found* — is the camera ever near it, does
the feed name it, does the plaque change — before it is judged on how it looks. An event nobody
is looking at has no spectacle however well it is modelled. City appearance is explicitly out of
scope (two other judges hold it) **except** where fabric breaks play.

## 7. Does it run? — weight 1, pass/fail

Real-time frame rate with the rAF loop actually running, not a fast-forward. ≥60 fps at the
shipped tier or it is a finding. Boot time from the front door to a playable field.

## 8. The record — weight 2

The one multiplayer feature that ships. Graded as a player feature, not as a determinism gate
(`tools/qa-replay.mjs` grades the bits): can I get a token without a console, does playback say
it is playback, does taking command hand me an army I can order, and does the game tell the
truth about what it just did.

---

## How the instruments are kept honest

- **Everything asserts.** `ck(name, ok, expected, actual)` is the only way a claim is made in
  `tools/judge/`. A run that proves nothing says so in its last line. This is not pedantry: all
  six scripts in `tools/scratch/pl-*` were driving a menu they could not reach for two days and
  produced narrative logs throughout, and every one of them still polls
  `.endcard, .result, .verdict, .battle-result, .result-sheet, .outcome` for the end of a battle
  when the panel the product renders is `.rs-panel` — so no playability run in this project's
  history has ever seen a battle finish.
- **Fast-forward by ticks, never by seconds.** `Engine.advance`'s own comment: 900 ticks at
  1000/60 against 901 at 166 ms is a different battle. `advanceTicks(n, 1000/60)` is the only
  comparable schedule and is what this rig uses.
- **The seed is typed into the menu field**, because there is no `?seed=`, and the rig asserts
  the field took it *and* that twelve seeds give twelve distinct state hashes — or "twelve
  seeds" is one measurement repeated twelve times.
- **The product's own state hashes are recorded at fixed ticks** on every campaign run, so a
  later re-run can prove whether the tree moved before anyone argues about whether it felt
  different.

---

## Pre-registered: judging a change that is defensible on paper

Recorded **before the change lands and before any after-data exists**, so the criteria cannot
be fitted to the answer. Baseline pinned at `f4be695` / src `0e659d472a58c8f2`,
2026-08-22T02:38Z, in `screenshots/judge/shape/`.

The change is expected to move survivors at t+200 by about 2.6 % on the default field battle by
flipping a small number of discrete decisions. **A per-seed before/after comparison is not a
valid test of that** — if decisions land differently, seed 7 before and seed 7 after are simply
two different battles, exactly as seed 7 and seed 8 are. The only valid question is whether the
*distribution* moved, so these are distribution criteria and the baseline's own seed-to-seed
spread is the yardstick.

I will call the change **perceptibly worse** if any of these hold:

1. **Outcome mix collapses.** The before-set shows ≥2 distinct `verdict/reason` outcomes and
   the after-set shows 1.
2. **Battles stop being in doubt.** Mean contested window (contact → verdict) falls by more
   than one before-set standard deviation.
3. **The lead stops changing hands.** Mean advantage flips falls to ~0 having been ≥1. This is
   the most perceptible single thing on the list and it is weighted accordingly.
4. **Battles never get close.** Mean `minGapAfterContact` rises beyond the before-set's spread.
5. **Anything I can name from a played-through session** and reproduce with map, seed and tick.

I will call it **imperceptible** — plainly, without hedging — if 1–4 all sit inside the
before-set's own spread and 5 turns up nothing. That is the expected answer and it is a real
finding, not a shrug.

I will refuse to answer at all if the state hashes show the tree did **not** move, because then
I would be grading noise.

---

## An instrument of mine failed, and the failure is the one this project names

Recorded because a judge who hides his own false positives is not one.

I set a watch for the incoming change that hashed `src/` and compared it against my pinned
baseline. It reported **both** `main` and the integration tree as MOVED while both were sitting
on the commit they had started on. The cause:

| | file set | source |
|---|---|---|
| the baseline | `find src -type f \( -name '*.ts' -o -name '*.css' -o -name '*.glsl' \)` — **192 files** | the **worktree** |
| the watch | `git ls-tree -r --name-only -- src` — **199 files**, unfiltered | the **git tree** |

Two different functions over two different file sets, so they could never agree, and the
disagreement was constant rather than intermittent — which is why it fired immediately and
looked like a real event.

This is exactly the standing rule in HANDOFF: *a self-consistent instrument can never fail;
compare against something outside the thing being checked.* I compared a tree against a
differently-computed version of itself. The replacement compares **commit SHAs**, which are
already a content hash of the tree computed by one implementation, so there is no second
implementation left to disagree with.

The general lesson for this rubric, and it applies to the game as much as to the watch: **a
derived number must be derived once.** It is the same defect as three panels each deciding for
itself what "the breach" means, which `src/ui/siege.ts` exists to prevent — and the same defect
as the result card re-deriving which victory condition fired instead of being told.

## Grading two changes that arrive together

Two changes are inbound: **A**, the quantisation firewall (~2.6 % at t+200), and **B**, the
honesty and order fixes taken from round one. They will not be separable by *when* they land.

They do not have to be. Because every campaign here is a script and every baseline is pinned to
a commit, **any two changes that are separate commits can be graded separately after the fact**
— check out each, run the identical campaigns, compare each against the baseline for its own
base. The thing that would actually prevent separation is not simultaneity, it is a squash.

The live hazard is different and is already present: `e/fix/game-tells-the-truth` is based on
**`main` (58bc584)**, which is **29 commits behind** the integration tree all three of my
baselines were taken on — and those 29 commits touch `BattleFlow.ts` (where `censusWall` lives),
`Siege.ts`, `WallDoctrine.ts` and `TacticalAI.ts`. Grading B against the integration baseline
would price the honesty fixes *plus* the lateral-census fix, the AI storm doctrine, both rams
and the quality/sim split, and call the total B. So a second set of baselines has been taken on
`main` itself (`tag=mainbase`), and B is graded against whichever base it actually lands on.

---

## Criteria RE-DERIVED against 10.0% / 18.2%, replacing the 2.6% version above

The figure I pre-registered against was wrong: the change is **−10.0% at t+200 and −18.2% at
t+400** on the shipped field-battle seed, not 2.6%. The 2.6% was the tick-only half. My
conclusion that it was 1.05σ and therefore imperceptible **does not survive**, and the
superseded version is left standing above rather than edited, because a pre-registration that
gets quietly rewritten is not one.

### What the correct arithmetic says, on my own baseline

```
t+200   n=8   mean 6691.1   sd 165.5   range 6456-6986   spread 530 = 7.9% of mean
        a 10.0% shift = 669 men = 4.04 sd          (I had said 1.05)
```

**Three things follow, and the second is the one that matters.**

**1. t+400 is the wrong place to measure and the −18.2% headline should not be used for
perceptibility.** Only **2 of my 8 seeds are still being fought at t+400**; the other six were
decided at t+311–393 and the median verdict is **t+367**. A survivor count at t+400 is, in
three-quarters of the seed set, counting men trickling off a field whose result has already been
called. **t+200 sits inside the contested window in 8 of 8** and is the only honest checkpoint
of the two.

**2. At t+200 the effect is *larger than the entire seed-to-seed spread*, which inverts the
frame it is being defended with.** The defence is "the firewall's effect is the same order as
changing the seed — 18.2% against a 14.2% seed spread". Both of those are t+400 numbers. At
t+200, where the battle is actually live, the seed spread is **7.9%** and the effect is
**10.0%**. The effect exceeds the whole distance between the best and the worst seed.

Stated without a sigma, which is the form that decides it: **6691 − 10% = 6022, and the
pre-change minimum was 6456.** If the shift is systematic, *the average battle after the change
is bloodier than the worst battle before it.* No amount of rerolling beforehand could produce
it. That is precisely what "a player cannot distinguish it from a reroll" has to mean, and on
these numbers it fails.

**3. 2.6% / 10.0% / 18.2% are not three effects. They are one divergence sampled at three
times.** The mechanism given for the sibling change says so outright — *two men differing at
t+90 becomes fifteen hundred by t+400*. So the "size" of this change is a **growth rate**, not a
number, and the honest question is whether the amplification outruns the battle. On this
baseline it reaches roughly 10% by the time the median battle is half over and ~15% by the time
it ends.

### The claim that actually decides it, and it is decidable

A reroll is a **draw from** the distribution. A change that moves every seed the same way
**moves** the distribution. Those are different in kind even when equal in men, because what a
player learns over twenty battles is the *mean*, not a sample — "the line usually holds about
here" is an expectation, and a translation breaks it while a reroll never can.

So the frame reduces to one empirical question — **translation or reshuffle?** — and a sign test
across the seed set settles it. All eight seeds moving the same way is p = 2/256 = 0.008 under
reshuffle. `tools/judge/jg-compare.mjs` runs it, along with the "does the after-mean clear the
whole before-range" test, and **refuses to grade at all if the state hashes show the tree did
not move.**

### The re-derived criteria

Because a 4σ effect will be visible to the instrument whatever it does to the game, these
separate *detectable* from *worse*.

| # | test | threshold, from the measured baseline |
|---|---|---|
| 1 | translation vs reshuffle at t+200 | all-same-direction across 8 seeds ⇒ translation ⇒ the reroll defence fails |
| 2 | after-mean vs before-range at t+200 | outside 6456–6986 ⇒ unreachable by rerolling |
| 3 | contested window | mean moves > 87.3 s (its own sd) |
| 4 | decided-at | mean moves > 85.4 s; **on Rome assault, any verdict outside t+104–125** |
| 5 | outcome mix | any change from 8/8 Defeat/rout on the integration tree; on `main` the field battle already yields ≥2 outcomes, so the criterion has force there |
| 6 | the sensitive detectors | Rome assault: their-first-break outside **t+42.17–42.43**, contested window off its five observed values |
| 7 | the played arm | Pydna passive Defeat t+336 vs played Victory t+1141 — if the played arm stops being a victory, that outranks every number above |

### What I will not assume

**That fewer survivors is worse.** My own round-one finding is that the field battle's back half
is a grind — Rome's headcount sat unchanged at 2 056 for 100 s and at 1 645 for 60 more, with
"The lines have met" repeating. A change that makes battles bloodier and shorter could **improve**
this game, and criteria 3–7 are written to detect movement in either direction. I will report the
direction and judge it in prose; the arithmetic does not get to decide it by its sign.

### Two changes, not one

The `hypot` sweep in world generation moved the shipped seed's t+400 count from **4 288 to
5 849** — **+36%, larger than the firewall's −18.2% and in the opposite direction.** Together
they could very nearly cancel at t+400 and read as nothing. Each is graded against the base it
lands on, identified by branch, never by when I noticed it.
