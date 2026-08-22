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
