# Multiplayer — what the measurement allows, and what to build

**Status: design pass. Nothing here is built.** Written at `66b220b` from the work of nine
agents who between them ran cross-engine determinism rigs, a transport survey, a prior-art
survey, three architecture designs and three adversarial reviews of those designs. Every number
below is attributed to the pass that produced it. Where two passes disagreed, the disagreement
is stated and one side is chosen with a reason. Where I re-derived a number myself, it says so.

This document exists because "add multiplayer" is not one decision. It is a determinism
decision, then a transport decision, then a scope decision, and the first one governs the other
two so completely that most of this document is about arithmetic rather than networking.

**The short answer, before the evidence.** Realtime multiplayer across browsers does not work on
this codebase today, and it fails inside the length of one battle. It can be made to work — the
failure is shallow and named — but the fix is a week of determinism hygiene plus a vendored
transcendental library, and until that lands, any realtime mode ships with a same-browser,
same-build restriction that is a worse product than no multiplayer. What is buildable now, at
one developer's scale and on a static site with no backend, is the **replay record**: the order
log plus the seed, which is a shippable single-player feature, the precondition for every
realtime option, and the only instrument in this project that can catch the next piece of
simulation state written from outside a tick.

---

## 0. How to read this

Tags on every claim that carries a number:

| tag | means |
|---|---|
| **[M]** | Measured in this design pass by one of the nine agents, with the pass named. |
| **[M×n]** | Measured independently by *n* passes that agreed. The strongest evidence here. |
| **[V]** | Verified by me at `66b220b`, either by reading source or by re-running the arithmetic. |
| **[D]** | The passes disagreed. Both figures given; one chosen, with the reason. |
| **[U]** | Unmeasured. An inference from code or from the literature, flagged as such. |

**Two standing warnings from this project's own history.** Roughly as many defects here have
been in the instruments as in the product, and this pass was no exception: two agents found
and fixed defects in their own rigs mid-flight that had *already produced published numbers*,
and three of the design documents contain at least one table that cannot be true. Where a
number survived only one instrument, it is marked. And twelve seeds is not an arm — almost
every result below is one seed, one machine, one browser build, which is why §7 is as long as
it is.

---

## 1. What the measurement says

> **Superseded in part, 21 August 2026 — `e/tools/determinism-cliff`.** Three claims in §1 are
> no longer true of the tree, and the change that falsified them is the one this document
> recommended. The gate now runs to **t+250 and t+400**, so t+200 is no longer the last
> checkpoint. `UnitGroupState` **is** hashed — twice, as `uf64` (exact float64 bits, warning
> against the baseline, hard-fail A-vs-B) and `uctl` (the discrete half, hard-fail
> everywhere). And the linter's portability scope now covers `src/city`, `src/terrain` and
> `src/maps` as well. The `Math.hypot` substitution landed at **222 sites** and was free
> exactly as measured: zero pool hashes moved across 21 checkpoints of three battles, and all
> 21 survivor counts were identical.
>
> The call-site figures in §1.3 were also slightly off — `hypot` was 158 in `sim+ai+units` and
> 89 in `terrain+maps+city`, now 0 and 25.
>
> One result is worth adding to the record because it justifies the whole pass: that 222-site
> change moved **`uf64` at 21 of 21 checkpoints and `uctl` at 0 of 21**. It perturbed the
> simulation's own float64 state everywhere, never reached a control-flow decision, and never
> survived the float32 round trip. **The gate as it stood would have reported that nothing
> happened.**


> **Superseded in part again, 21 August 2026 — `e/tools/xengine-arm`.** Stage 0 item 5 is
> built (`tools/qa-xengine.mjs`), the last 27 `Math.hypot` sites are gone, and the arm's first
> outing changes four claims in §1 and one estimate in §3. **Everything below is now measured by
> a standing instrument rather than by a pass that has since gone home**, which is the point of
> item 5 and is worth more than any single number in it.
>
> **§1.2 is closed. The Carthage assault boots identically in three engines.** Before the sweep,
> at t+0: three different pool hashes, and 838 of 3,440 men differing between Chromium and
> Firefox — 423 in x/z, **415 in y only** — and 713 between Chromium and WebKit, of which **361
> were y-only with a worst gap of 3.8691 mm**. That is §1.2's "361 wall garrison … up to 3.87 mm"
> reproduced to four significant figures by a different rig on a different tree a year later,
> which is the strongest thing in this whole file. After the sweep: **one hash in all three
> engines and zero men differing**, and Chromium ≡ WebKit bit-identical including `uf64`. The
> residual was Firefox only and was named rather than inferred: **26 float64 fields of 1,020, all
> 1 ULP, all `facing` and `targetFacing` on 13 units**, from the boot-time `Math.atan2(m.nx,
> m.nz)` calls in `scenario.ts`'s `deployAssault`.
>
> **§1.1 is not closed, and `hypot` was never going to close it.** The field battle is still
> identical on `hash`, `uctl`, `count` and `alive` in all three engines at t+0/30/90/150/200 and
> **all three are apart at t+250 and t+400** — 5,849 / 5,560 / 5,886 survivors, Chromium against
> Firefox 4.9% apart. The escape at t+205.5 is exactly where it was. Two different problems were
> being conflated: map generation decides the *boot*, and the tick loop decides the *battle*.
> (**The battle half is closed too, three paragraphs down, and by something else entirely.** Read
> to the end of this block before quoting any of it.)
>
> **The leading indicator, which is the most useful operational number here.** On that same run
> `uf64` — the float64 unit layer — was already apart at **t+30**, one hundred and seventy
> simulated seconds before the pool hash could see anything. §1.4 predicted exactly this and now
> it is a standing measurement. **A lockstep implementation should exchange `uf64`, not the pool
> hash**: it catches a fork nearly two orders of magnitude earlier in simulated time, it costs
> 0.08–0.12 ms, and it is already in the product at `src/sim/stateHash.ts`.
>
> **§1.3's call-site table is now zero for `hypot` in every scanned directory.** The last 27
> went: 11 in `src/terrain`, 15 in `src/maps` (12 of them in `src/maps/carthage/heightfield.ts`)
> and **one in `src/city/rome/circuit.ts` that was a regression** — `tools/check-determinism.mjs`
> was already reporting it, because `hypot` had been cleared out of `src/city` deliberately and
> a hit there is new code putting it back. The linter's `hypot` row now says so.
>
> **And then the thing this document said was a 3–5 week project turned out to be one file.**
> §1.4 already had the whole argument written down: the soldier pool round-trips through float32
> every tick and holds for six thousand ticks, and `UnitGroupState` is plain float64 integrated
> in place with no quantisation step anywhere. §3 Stage 3 names the fix — `Math.fround` on the
> integrated fields — and then prices it inside a vendored-libm project at 3–5 weeks. It is
> `src/sim/quantise.ts`, it is about a hundred lines of which ninety are the comment, and with it
> **all three battles are bit-identical in Chromium 151, Firefox 153 and WebKit 26.5 at all seven
> checkpoints, t+0 through t+400** — pool hash, `uf64` and `uctl`, 8,632 / 3,440 / 3,072 men.
> The t+205.5 escape is closed. Five seeds, a control, the cost and the caveats are in the
> Stage 3 rewrite.
>
> **`uf64` is therefore no longer a warning.** This document says it cannot be a gate because a
> Chromium point release moves it on its own; that was true of an unquantised layer and is not
> true of a quantised one. `qa-determinism.mjs` now hard-fails on it by default and `--soft-units`
> is the escape. **A `uf64` drift on an unchanged tree is now a finding, not a browser update.**
>
> **And one instrument defect worth more than any number here, because it is the kind that
> publishes.** Re-verifying the committed tree while nine agents were running, the arm reported
> the Carthage assault **diverging in Firefox at t+0 with a different `uctl`** — a control-flow
> difference before a tick was supposed to have run. That is not a shape a rounding difference can
> take, which is the only reason it was investigated rather than written up. The cause is a race
> every browser harness in this repository has: `main.ts` calls `engine.start()` at the end of
> `boot()` and *then* sets `__game.ready = true`, so a tool that waits for the flag and **then**
> evaluates `engine.stop()` has a driver round trip of rAF in between, and every frame carries
> ticks. Unequal tick counts, compared as if equal, on a loaded machine. `qa-determinism.mjs` has
> named this race in its own header since it was written, printed `simTime` on every line, and
> never compared it.
>
> Both tools now stop the clock **inside the page**, on the `ready` assignment itself, and both
> now *compare* `simTime` rather than printing it — in `qa-xengine` as a seventh vacuity assertion
> that voids the run. Every number in this block was taken with `simTime` reading exactly the
> checkpoint, which the logs confirm; they were taken before the check existed, which is worth
> knowing when reading them.
>
> **The gate's port hazard is closed and it was real.** `qa-determinism.mjs` reused any listener
> that answered on its port, which in a checkout with eighty worktrees on a handful of default
> ports means it could measure another agent's branch against this tree's baseline and report the
> verdict confidently. It caught a live collision the day it was investigated: another agent's
> worktree on port 5901, ten files different. Both determinism tools now go through `startVite`
> in `tools/lib/browser-budget.mjs`, which asks the listener which worktree it is serving
> (`/__tc/tree`) and refuses a foreign one; `qa-xengine.mjs` sets **`TC_STRICT_TREE=1`**, which
> also refuses a listener too old to answer at all. The same investigation found the orphan
> mechanism behind nineteen stranded Vite processes and a load average of 72 — harnesses spawned
> `npx vite`, and SIGTERM kills the `npx` wrapper while the server keeps the port.
> `tools/lib/vite-runner.mjs` is Vite in its own process, in its own process group, polling its
> parent, and it is what `startVite` spawns.

### 1.1 Everyone who stopped at t+200 said IDENTICAL. Everyone who went past it said DIVERGENT

`tools/determinism-baseline.json` pins five checkpoints per battle: t+0, t+30, t+90, t+150,
**t+200**. That is the last checkpoint in the project, and `tools/qa-determinism.mjs --at` stops
there too. **[V]**

The default field battle diverges between Chromium and WebKit at **t+205.5 s**. **[M: xengine]**

That is 5.5 seconds past the end of the gate. It is not a coincidence that it went unnoticed —
it is the gate defining the horizon of every measurement anyone had taken. Three separate passes
ran three browser engines against this battle and reported bit-identical results, and all three
were right, because all three stopped where the baseline stops:

```
t+  0  0fa6e702  8632/8632      identical in Chromium 151 / Firefox 153 / WebKit 26.5,
t+ 30  c6ef8d38  8632/8632      and all five reproduce determinism-baseline.json exactly
t+ 90  02c1ae6e  8316/8632
t+150  e4489ef0  7459/8632
t+200  be60dea6  6623/8632
```
**[M×3: xengine, determinism, transport]**

Past it, they never re-converge:

| | t+205.4 | t+300 | t+400 | t+500 | t+600 |
|---|---|---|---|---|---|
| Chromium alive | 6555 | 5723 | 4824 | 3497 | **2766** |
| WebKit alive | 6555 | 5891 | 5251 | 4687 | **4281** |
| Firefox alive | — | — | — | — | **2954** |

**[M: xengine]** A 55% difference in survivors at ten minutes. Two different battles. The
transport pass measured the same fork independently on a 5-second grid and saw it as a step
function, not a slope — 2 picometres apart at t+205, 6.5 m and 516 men displaced at t+210.
**[M×2: xengine, transport]**

### 1.2 One battle is a different battle in three engines before a single tick runs

The Carthage assault does not survive to t+200. It diverges at boot:

```
         t+0 canon    alive@t+200
Chromium  dbdd3a70    2851
Firefox   899b275a    2836
WebKit    5b3b8f8e    2825
```

Two passes produced those three hashes independently and got the identical hex strings.
**[M×2: xengine, determinism]**

The instrument checks that make this believable: the t+0 *integer* hash is `06a98a58` in all
three engines — same roster, same units, same slots, same ranks, so this is not a different army
— and each engine reproduces its own t+0 hash across three independent page loads, so it is not
boot-order noise. **[M: xengine]** Rome's assault, on a straight wall, is identical in all three
engines at every checkpoint. **[M×2]**

The divergence splits into two disjoint populations: 340 attacking infantry differ in x/z by 1–2
float32 ULP with y identical, and 361 wall garrison stand at *identical x/z* and differ in y by
up to 3.87 mm. The garrison's foot height comes from the wall structure, so this is curved-wall
geometry, not the terrain heightfield. **[M: xengine]** A second pass localised its own version
of this chain to `sOuter` in `city/carthageWall.ts` and then to a ~1.8 mm difference in a `gMin`
taken over 21 terrain samples, and was honest that the final `heightAt` step was inferred from
magnitude rather than instrumented. **[M: survey, partial]** A third pass bisected single
functions and named `Math.hypot` alone as sufficient to reproduce it. **[M: determinism]**

Note what this means for the linter: `tools/check-determinism.mjs` defaults its scope to
`src/sim,src/ai,src/units`. **[V]** `src/city` is not scanned, and `src/city` is where this
battle breaks.

### 1.3 The cause is named, and it is not exotic

`Math.sin/cos/tan/exp/log/atan/atan2/asin/acos/cbrt/hypot` are *implementation-approximated* in
ECMA-262. The spec recommends fdlibm and requires nothing. `+ - * /` and `Math.sqrt` are
required to be correctly rounded, and JS has no fused multiply-add — so the arithmetic that
ruins C++ determinism is already exact here, and the hole is exactly the transcendentals.

Five passes measured the disagreement rates, each generating inputs from integer-only arithmetic
so the input bit-vector is *asserted* identical in every engine, and each carrying `sqrt` and
`a*b+c` as controls. The controls came back clean everywhere, in every pass. Representative
figures, Chromium/Firefox/WebKit on arm64 macOS:

| fn | worst pairwise disagreement | max ULP |
|---|---|---|
| `tan` | 41% | 3 |
| `hypot` | 37% | 2 |
| `atan2` | 17% | 1 |
| `acos` | 17% | 1 |
| `exp` | 10% | 1 |
| `sin` / `cos` | 4% | 1 |
| `pow` | **0%** | 0 |
| `sqrt` (control) | **0%** | 0 |

**[M×5]** The passes' individual percentages vary by a few points — different input ranges, 512
to 50,000 samples — but the ranking is stable across all five and `hypot` and `tan` are the
worst in every one of them.

`pow` agreeing on all three engines is luck, not a guarantee, and two passes caught it
disagreeing elsewhere: Chrome 130-x64 versus Chrome 151-arm64 differs on `pow` for 10.5% of
inputs. **[M×2: determinism, priorart]** Do not clear `pow`.

Call-site counts, mine at `66b220b` **[V]**, which differ slightly from the passes' figures
because they measured at `3595b48` and used different scopes:

> The `hypot` row of this table is **0 and 0** as of 21 August 2026 and a non-zero entry in either
> column is now a regression the linter reports by name. The `pow` row is the cheapest thing left
> on it: 15 of the 39 calls are `Math.pow(x, 2)` or `Math.pow(x, 3)`, which are `x * x` and
> `x * x * x` written the unportable way.

| | `src/sim` + `src/ai` + `src/units` | `src/terrain` + `src/maps` + `src/city` |
|---|---|---|
| `hypot` | 158 | 90 |
| `sin` | 195 | 242 |
| `cos` | 199 | 209 |
| `atan2` | 64 | 33 |
| `exp` | 69 | 20 |
| `tan` | 7 | 0 |

Live call rate in the tick loop, instrumented and gated to `fixedUpdate` only, at 8,632 men:
**60,839 transcendental calls per tick**, of which `hypot` is 28,524 and `exp` is 25,966 — about
1.83 million per simulated second. **[M: determinism]** A second pass measured 1.5 M `hypot`
calls per simulated second. **[M: priorart]** The two figures are the same measurement to within
a factor the different scopes explain.

### 1.4 Why it takes 6,000 ticks and then goes off a cliff

`SoldierPool` is entirely typed arrays. Every tick reads float32, computes in float64, writes
float32. A 1-ULP double disagreement (2.2e-16 relative) survives that write only if the two
doubles straddle a float32 rounding boundary (quantum 1.19e-7) — roughly 2e-9 of the time. **That
quantisation is the whole firewall**, and it is the reason three engines agree bit-for-bit for
6,000 ticks.

One pass proved its instrument could see through the firewall before believing it, by injecting a
faithful perturbation — ±1 double-ULP, keyed on input bits so the same input is always wrong the
same way, at the measured per-function rates — inside Chromium alone:

| perturbation | first pool-hash difference | first control-flow difference | first survivor difference |
|---|---|---|---|
| 1 ULP (the real magnitude) | frame 3519 | none in 6000 frames | none |
| 1e-15 | frame 3019 | none | none |
| 1e-14 | frame 197 | none | frame 4415 |
| 1e-13 | frame 78 | tick 2566 | tick 2655 |

57.5 million perturbed results at true magnitude moved the pool hash once. **[M: xengine]** Two
other passes ran the same experiment shaped differently — 592 million ±4-ULP injections over 200 s
**[M: determinism]**, and a nudge ladder finding the break at 2^20 ULP with a clean wrapper
control **[M: priorart]** — and all three agree: the tick loop has about 29 bits of headroom
against 1–3 ULP of libm disagreement.

**The leak is the layer nobody hashes.** `UnitGroupState.x, z, facing, targetX, targetZ,
targetFacing, morale, fatigue, ammo, chargeTimer, routTimer` are plain JS doubles, integrated in
place, with no quantisation step anywhere. Nothing in this repo hashes them. Measured drift
between Chromium and Firefox over 35 units × 11 fields:

```
tick     30   300   600  1200  1800  2400  3000  4200  5400  6000
differ  3/385 6/385   51    36    61   102   126   143   166   168
maxULP     1     1    74     7    22  6662  3087  2846 16974 16974
```

**[M: xengine]** The simulation's own state is engine-dependent from t+1 s. Only its float32
projection — the only thing any gate here hashes — is not. Two independent passes reached the
same conclusion from different directions. **[M×2: xengine, transport]**

And the amplifier that carries a 1-ULP double difference into a float32 flip is a specific line:
`dx = tx - p.x[i]` differences a float64 unit-space target against the man's float32 position.
For a man near his slot that destroys about three decimal digits of agreement — measured at a
single differing tick, 1.3e-16 relative in becomes 3.1e-13 relative out, a ~2,400× amplifier in
the hot path of every soldier every tick. **[M: xengine, single trace]**

### 1.5 A routine Chrome update is as dangerous as a different browser — but the unit is a *libm generation*, not a build

> **Re-measured 21 August 2026 by `tools/qa-xengine.mjs --libm-only`, and this is now a standing
> arm rather than a one-off.** Eight builds — Firefox 153, WebKit 26.5 and every Chromium in the
> Playwright cache — over 4,096 integer-generated inputs per function across fourteen
> approximated functions, with `inputs`, `sqrt` and `a*b+c` as controls. **All three controls were
> identical across all eight builds**, which is what makes the rest of it evidence.
>
> ```
>     130.0.6723.31 → 143.0.7499.4     1/14   pow
>     143.0.7499.4  → 147.0.7727.15    0/14   identical
>     147.0.7727.15 → 149.0.7827.55    0/14   identical
>     149.0.7827.55 → 151.0.7922.34   12/14   tan atan2 acos asin exp sin cos log log1p expm1 atan cbrt
>     151.0.7922.34 → 152.0.7977.8     0/14   identical
> ```
>
> Three corrections and one reframe.
>
> **Chrome 143 = 147 = 149 is confirmed** — 0 of 14 on both transitions.
>
> **"Chrome 149 → 151 changed eleven of twelve, `hypot` was the only one that held" is wrong on
> the second half.** Twelve of fourteen moved and **two** held: `hypot` *and* `pow`.
>
> **"Chrome 130-x64 → Chrome 151-arm64 differs on nine of sixteen, including `pow`" localises
> better than that.** 130 → 151 differs on 13 of 14 here, but 130 → 143 differs on **exactly one
> function, `pow`**, and `pow` is then identical across 143/147/149/151/152. So the `pow` change
> this file rightly refuses to clear happened at 143, not at 151.
>
> **And the reframe, which is the part that changes a product decision.** The generations are
> `{130}`, `{143, 147, 149}`, `{151, 152}`. Two players on Chrome 143 and Chrome 149 compute
> identically; one on 149 and one on 151 do not. So the constraint a realtime design would ship is
> **not "same patch build"** — it is "same libm generation", and one of those generations spanned
> at least six major versions. That is a materially better product than §2 describes, and it means
> a pairing handshake should exchange a **libm fingerprint** rather than a version string: fourteen
> hashes over 4,096 integer-generated inputs each, computed in under a second, and it is exactly
> as strict as it needs to be and no stricter. A version check would refuse pairings that work.
>
> What would change my mind: a generation boundary that falls *inside* a single Chrome major
> version — a security patch that ships a libm change — which this sample cannot see because the
> cache holds six majors and no two patches of one major. That is the measurement to take next
> and it needs a build source other than the Playwright cache.

Five Chromium builds are already in the Playwright cache. Across 512 integer-generated inputs per
function, with `sqrt` and `a*b+c` as controls:

- Chrome 143 = 147 = 149 on all twelve functions tested.
- **Chrome 149 → 151 changed eleven of twelve.** `hypot` was the only one that held.
- Chrome 130-x64 → Chrome 151-arm64 differs on nine of sixteen, including `pow`.

**[M×2: lockstep, determinism]** Then the actual game, same machine, same build of Total Claude,
exact-tick scheduler:

| battle | chrome 143/147/149 | chrome 151 |
|---|---|---|
| field, t+200 | `be60dea6`, 6623 | `be60dea6`, 6623 — identical |
| field, **t+600** | `ce37cd44`, **3916** | `db54f4b8`, **2766** |
| Carthage assault, t+0 … t+600 | `45bc1898`, 2002 | identical throughout |

**[M: lockstep]** Two battles, opposite verdicts, from one libm change. The field battle ends
42% apart; the siege survives ten minutes intact. This is the cleanest demonstration in the whole
pass that a single passing battle proves nothing.

Chrome ships a major version roughly monthly and auto-updates. So "same browser engine" is not
the constraint a realtime design would have to ship; **"same patch build"** is, and two friends
will routinely not have it.

### 1.6 Frame cadence does not reach the simulation, and three shipped comments say otherwise

`src/core/Engine.ts:549`, `src/main.ts:346-353` and `tools/qa-determinism.mjs:39-43` all
assert that equal tick counts with different frame grouping produce different hashes — *"Equal
tick counts are not enough; how many ticks share a frame reaches the simulation."* **[V]** That
claim is used to forbid coarse-stepping in every probe in the project.

It is false, and the cause is an off-by-one in tick count. Three passes measured it in the
browser and two reviewers reproduced the arithmetic in Node. I re-derived it a third time myself
at `66b220b` (`/tmp/tc-tickcheck.mjs`, a pure-Node replica of `Time.beginFrame` plus
`Engine.advance`'s synthetic clock):

```
t+30  (expect 900)   step 1000/60 -> 1800 frames, 900 ticks
                     step 166     ->  181 frames, 901 ticks
                     step 1000/6  ->  180 frames, 899 ticks
t+200 (expect 6000)  step 1000/60 -> 12000 frames, 5999 ticks
                     step 166     ->  1205 frames, 6000 ticks
```

**[V, and M×3]** Three step sizes, three different tick counts, differing at t+30 — which is
exactly the checkpoint the shipped comment says divergence appears at. The "exactly-five-tick"
`1000/6` arm loses one tick on its first frame, because `double(1/6)` is about 7e-18 short of
five times `double(1/30)`, so the fifth subtraction fails once; `maxStepsPerFrame = 5` means it
can never make the tick up. **The arms were never comparing equal tick counts.**

When the tick counts are forced equal, the passes that drove the browser found the hashes
identical — across 1, 2, 3, 5 and 30 ticks per frame, on the f32 pool hash, on a 36-field pool
hash, and on a float64 hash of all 35 `UnitGroupState` objects, on both the field battle and the
Carthage assault. **[M×3: lockstep, relay, async]**

Two consequences, and the second is worth more than the first. Probes may take the coarse step
they currently forbid — the passes measured a 1.7× to 2.3× saving. And **the simulation is a pure
function of (config, seed, tick index)**, which is the precondition for a peer at any frame rate,
for a stalled client catching up, and for a replay played back at 8×.

One honest caveat and one refutation. The caveat: a grouping arm at 20–30 ticks per frame does
move one pool field, `grime`. The refutation: the pass that found it explained `grime` as
render-only, and that is wrong. `grime` has two writers — `src/vfx/CombatFX.ts` through the sink
at `src/main.ts:234`, in the render phase, **and `BattleSystem.ts:3459` inside `fixedUpdate`**,
in `damage()`. **[V]** It is a read-modify-write accumulator with one writer in each phase. The
verdict stands (exclude it from any desync hash, which the repo's canonical hash already does),
but the right fix is to move `grime` out of `SoldierPool` into a render-side array, not to hash
around a field the simulation writes on every blow.

### 1.7 Costs, where the passes disagreed and one of them is arithmetically impossible

**Tick cost. [D]** One pass reported 11.06 ms per tick at 8,632 men and used it to rule out
rollback. Four other measurements — 3.3 ms **[M: lockstep]**, 3.40 ms **[M: relay]**, 3.58 ms
**[M: async]**, and the repo's own `docs/HANDOFF.md` at 3.00 and 3.657 ms **[V]** — cluster
around 3.4. **Believe 3.4 ms.** The 11.06 figure is a whole frame including every `update()` and
`preRender()`, not a tick; the async pass reconciled the two by solving two arms for their
components and got 3.58 ms of tick plus 2.92 ms of per-frame non-tick work. That is a ~10%
occupancy of a 33.33 ms tick, not 33%, and it changes the argument against rollback (§4.4).

**Hash cost. [D]** For a FNV pass over x/z/state/hp at 8,632 men, the passes reported the aliased
`Uint32Array` version at 0.116 ms, 0.16 ms, 0.141 ms — and 2.09 ms. **Believe ~0.15 ms**, and the
reason is arithmetic rather than authority: the loop is 8,632 × 4 fields × 4 byte-mixes ≈ 138,000
iterations of an xor and an `imul`. At 2.09 ms that is 15 ns per iteration, which is roughly
fifty times slower than a tight JS integer loop on this hardware. 0.15 ms is about 1 ns per
iteration, which is right. The outlier's own DataView comparison came out at 2.17 ms — within 4%
of its "optimised" number — which is the signature of a benchmark that measured the same code
twice. Either way the conclusion is the same and is not in dispute: **a per-tick state hash is
affordable and a per-second one is free.**

**The gate's hash arithmetic.** `tools/qa-determinism.mjs:141` uses `h = (h * 0x01000193) >>> 0`.
**[V]** Above 2^53 that float product rounds, so this is *not* FNV-1a — about 87.5% of the
products exceed 2^53, a figure two passes computed independently and agreed on. It is
deterministic, its avalanche was measured clean (0 missed single-bit flips in 20,000 trials), and
it is what `determinism-baseline.json` pins. **Do not "fix" it to `Math.imul`** for a few percent;
that silently invalidates fifteen pinned hashes.

**Bandwidth. [M×3, in agreement]** One order serialises to **11–13 bytes** (kind and flags 1,
selection bitmask 5, x/z as int16 over `HALF_EXTENT = 1400` **[V]** giving 4.3 cm resolution 4,
facing 2, aux 1). At a 100 ms network turn that is **~1–2 kB/s per player per direction**
including WebRTC or WebSocket framing overhead, which the passes were careful to state
explicitly because it dominates the payload roughly ten to one.

State sync of the pool, by contrast, per direction:

| encoding | per snapshot | at 10 Hz |
|---|---|---|
| all 37 fields, raw | 1,028 kB | 253 Mbit/s |
| x/z/state/hp as stored | 110 kB | 26.9 Mbit/s |
| x/z u16, facing/state/hp u8 | 59 kB | 4.8 Mbit/s |
| the same, only the ~25% that moved | 15 kB | 1.2 Mbit/s |

**[M×2: transport, priorart]** The most generous state-sync encoding anyone could construct is
about 130× the busiest orders stream, and it is a lower bound built on assumptions that flatter
it — in a siege, every man is moving and both players are looking at the same contact line, so
the compressible fraction is smallest exactly when it matters. **State sync is ruled out on
bandwidth before any argument about latency.**

### 1.8 The one thing measured that nobody expected: the simulation can be snapshotted

One pass tested whether the sim can be captured and resumed, which every reconnection, late-join
and desync-recovery claim depends on and which nobody had checked. Snapshot at tick 1799, run
1,800 ticks of a *different* battle over the top, restore, run 1,800 ticks again — bit-identical
to the uninterrupted run on the 4-field pool hash, on a 36-field hash, on a float64 hash of all
35 unit states, and on survivor count. True on all three shipped battles including both sieges.
Take 9–14 ms, restore 4–7 ms, 641 kB gzipped after excluding derived structures. **[M: relay,
single pass]**

Four traps found on the way, each of which silently broke the rewind until fixed, and all four
verified in source by me:

1. **`src/sim/combatShared.ts:195-196` — `const MODS` and `const SIGNALS` are module-scope.**
   **[V]** They carry decaying per-unit combat state that the next tick reads, they hang off no
   system instance, and nothing that walks `engine.systems` can reach them. The module already
   exports `resetCombatShared()`, so it knows it is stateful. **[V]**
2. **`Map` insertion order is simulation state.** `battle.routeGoals` restored with correct
   contents but original key order produced a different battle. A restore must clear and reinsert
   in captured order. (The determinism survey cleared Map iteration order as a cross-engine
   non-issue — correct for cross-engine, wrong for snapshots.)
3. **`grime` and the three `lastCostMs` fields are not simulation state** and produce false
   desyncs if hashed. `lastCostMs` holds `performance.now()` deltas.
4. **Do not walk `ctx`.** A reflective capture reached `ctx.events` and the restore wiped all 20
   EventBus subscriptions.

This is a strong single result and should be read as one. The shipping serialiser is a different
object from the reflective probe that proved this, and it is much larger than that pass budgeted
— its own reviewer counted 331 distinct mutated instance-field names across `src/sim` and
`src/ai`, over roughly 21,000 lines, with `private` declarations numbering 162 in `Siege.ts`
alone and `routeGoals` itself declared `private readonly`. Twelve systems need `capture()` and
`restore()` methods, not one module. And it is a permanent tax: `Siege.ts` is 6,192 lines and
under active change — this checkout has moved 34 commits since the pass pinned it. **[V]**

### 1.9 What the shipped code already gets right

Worth stating, because it is the reason any of this is tractable:

- **One typed order channel.** Every player and AI order goes through `orderIssued`
  (`src/core/events.ts:33`), with nine `kind` values, three subscribers (`BattleSystem.ts:727`,
  `Abilities.ts:87`, `Siege.ts:1400`) and fifteen emit sites in three files. **[V]**
- **The RNG is bit-portable.** `src/util/rand.ts` is `Math.imul`, xor and shift only, plus a
  divide by 2^32. It was bit-exact in every engine every pass tested. Divergence cannot enter
  through the random stream. **[M×4]** It already has `getState`/`setState`, documented for
  "deterministic save-scumming and replays". **[V]**
- **Per-unit randomness is keyed on id, not on draw order.** `this.rng.fork("unit" + u.id)`
  at `BattleSystem.ts:1005`. **[V]**
- ~~**`maxSoldiers` is frozen at Engine construction** and excluded from `AdaptiveQuality`'s patch
  list, so a mid-battle quality change cannot resize the army. Each peer can run its own render
  tier.~~ **[M×2, V]** **Half right, and the wrong half was the conclusion.** The freeze was
  real and it prevented exactly one failure: a settings-menu press resizing an army already
  deployed. It said nothing about two peers *booting* at different tiers, which is the case that
  matters here, and "each peer can run its own render tier" was false for as long as the tier
  chose the army — see §1.10 and §7.7bis. It is true now, and for a different reason: the field
  is gone. `SOLDIER_POOL_CAPACITY` (`src/sim/types.ts`) is one number at every tier, so
  `QualitySettings = RenderQuality` with no intersection, there is no simulation half to freeze,
  and the invariant is enforced by `tools/qa-determinism.mjs`'s cross-tier arm rather than by a
  private field and two re-assertions. Branch `e/core/quality-sim-split`.
- **Deployment already pauses the clock** (`deployment.ts:187`) and the zones are non-overlapping
  by construction. **[V]**
- **One input path is already correct.** `Siege.requestMachineOrder` queues to `machineOrders`
  and drains inside `fixedUpdate`, and its docstring states the rule the other twenty-three input
  paths break: *"every mutation of the simulation has to happen inside `fixedUpdate` or the
  battle stops replaying identically."* **[V]**
- **The battle setup is already one URL token.** `encodeConfig`/`decodeConfig`
  (`battleConfig.ts:914`) **[V]**, and `MainMenu` already ships a "Copy link to this battle"
  button.

### 1.10 And what it gets wrong, in ways that matter for any of this

- **Player orders are applied on the emitter's stack.** `EventBus.emit` is synchronous;
  `SelectionController` runs from `HudSystem.update` at order 700; `Engine.frame` runs every
  `fixedUpdate` before any `update`. So a player order lands in the gap *after* a frame's ticks —
  tick-adjacent by accident of subsystem ordering, never tick-numbered. **[V]**
- **`orderIssued` carries no provenance.** **[V]** There is no `source` field, and
  `src/ai/Orders.ts`
  emits on the same channel as the UI. Anything that records "the player's orders" from the bus
  records the AI's 6,159 orders per 200 s too, and on playback the AI regenerates them while the
  recorder re-emits them. This is the single most consequential code correction in the pass, and
  it invalidates the "zero simulation changes" claim of the asynchronous design.
- **`SelectionController.ts:1538` writes `u.width` directly** into `UnitGroupState`, and its own
  comment says to delete it once the sim honours `o.width`. `applyOrder` has honoured it for some
  time. **[V]** Left in, a frontage order is invisible to anything watching the bus.
- **`issueHalt` mutates `Siege` before emitting** — `cancelWallPlan` and `releaseEscalade`, from
  the update phase, outside any tick. **[V]** Note that the ordering is deliberate and commented:
  a design that moves these into `Siege`'s own `orderIssued` handler inverts it, because
  `BattleSystem` subscribes before `Siege` and `EventBus` iterates in insertion order.
- **Pause and speed are raw writes to the clock** from three places. Two machines pressing 2× at
  different moments run different tick counts for the same wall clock. **[V]**
- **`PLAYER_FACTION` is a compile-time constant** with 31 references across 8 UI files. **[V]**
  The second player cannot be anything but Rome.
- **`Time` sheds sim time.** `maxStepsPerFrame = 5` plus a 0.25 s `frameDt` clamp; measured, five
  300 ms stalls over 11.2 s of wall clock permanently lose 9 ticks. **[M: orders, V on source]**
  `time.tick` is a per-machine quantity and cannot serve as a shared clock unchanged.
- ~~**The quality tier silently changes the army.**~~ **Fixed, `e/core/quality-sim-split`.**
  `fittedUnitScale` fitted the army to `maxSoldiers`, so the field battle booted 8,632 men at
  `high` and 1,515 at `low` **[M×2]**, and the Campus Martius assault at one seed was 3,074 men
  at `ultra` against 3,009 at `medium` — with the ram crew dead 16 m short of the door at one
  tier and the Porta Flaminia open by t+240 at the other. **[M: video]** The owner's ruling:
  graphics settings must not change the outcome of a battle. The soldier pool is now
  `SOLDIER_POOL_CAPACITY = 12000`, one number at every tier, and `SimQuality` no longer exists.
  Measured across the change: `low` and `medium` grow to the `high`/`ultra` battle on all three
  pinned battles, `high` and `ultra` do not move at all, and **all 21 pinned checkpoints are
  bit-identical** — because `high` and `ultra` were already bit-identical (`Math.min` binds on
  the asked unit size long before the pool cap did) and the new ceiling is the old `ultra` one.
  Headcounts before → after, by tier:

  | battle | low | medium | high | ultra |
  |---|---|---|---|---|
  | field battle | 1,515 → 8,632 | 3,012 → 8,632 | 8,632 → 8,632 | 8,632 → 8,632 |
  | Rome assault | 1,533 → 3,074 | 3,009 → 3,074 | 3,074 → 3,074 | 3,074 → 3,074 |
  | Carthage assault | 1,538 → 3,440 | 3,014 → 3,440 | 3,440 → 3,440 | 3,440 → 3,440 |

  A pairing still cannot pin the *tier* name and call it done — it must exchange the effective
  `unitSizeScale` and `pool.count`, because the **build** can still move them (a roster strength
  edited, a `UNIT_SIZES` multiplier retuned) and because the battle-size row of the menu is a
  real and deliberate `BattleConfig` choice. What has changed is that the tier is no longer one
  of the things that can move them, so a lobby handshake is now about *builds and configs*
  rather than about hardware.
- **The gate's hash lives in the harness, not the product.** `window.__poolHash` is a string
  injected by `tools/qa-determinism.mjs`. **[V]** No FNV constants appear anywhere in `src/`.
  This is the project's recurring failure mode: the capability is in the instrument.

---

## 2. The recommendation

> **Amended 21 August 2026 — `e/tools/xengine-arm`. Step one of the four below is no longer
> true, and it was the step the other three rested on.**
>
> §2 says realtime needs cross-machine determinism and "this codebase does not have it across
> browsers". As of `src/sim/quantise.ts` it does, on this tree, for all three shipped battles and
> for five seeds of the field battle: **Chromium 151, Firefox 153 and WebKit 26.5 bit-identical on
> the pool hash, `uf64` and `uctl` at t+0, 30, 90, 150, 200, 250 and 400.** Measured by a standing
> arm with six vacuity assertions and an off-switch control, not by a pass that has gone home.
> Steps two, three and four are unchanged and all three have since happened: the `hypot`
> substitution landed at 249 sites, the replay record shipped, and a relay is still the right
> transport for the total-order reasons in §4.1.
>
> **What this does and does not license.** It licenses *pricing* realtime honestly, and it
> removes the worst thing in the product §2 describes — "your friend, on your browser, on your
> patch version, this week". It does **not** license skipping §4's list, and it does not make the
> desync tail in §5 shorter. Two things are unchanged and are now the binding risks rather than
> the second-order ones:
>
> - **§7.1 is still open and is now the whole premise.** Every number here is one machine.
>   Chrome-on-Alice against Chrome-on-Bob, two CPUs, two patch builds, is untested and cannot be
>   tested here — and the cross-architecture shortcut this document offers does not exist (see
>   §7.1's own correction). Three engines agreeing on one machine is strong evidence about libm
>   and no evidence at all about two machines.
> - **The firewall is a firewall, not a proof.** It reduces the straddle probability to about
>   2e-9 per field per tick. Long battles and unlucky seeds will still fork. The consequence for a
>   design is concrete: **a lockstep peer must exchange `uf64` every turn and have a policy for a
>   mismatch**, because mismatches are now rare rather than impossible. §4's "decide what a hash
>   mismatch means and be consistent" is still right — any mismatch is a fork — but a fork is now
>   a once-in-a-long-while event rather than a certainty, which changes what the UI should say.
>
> And one thing that got *cheaper* rather than merely possible: **`uf64` is the desync detector.**
> It saw the field battle's pre-firewall fork at t+30 while the pool hash held to t+200. It costs
> 0.08–0.12 ms, it is already in the product, and it is 8 bytes on the wire.

**Do not build realtime multiplayer yet. Build the determinism fix and the replay record, in that
order, and re-decide afterwards with better evidence than anyone has now.**

The argument in four steps.

**One: realtime of any shape needs cross-machine determinism, and this codebase does not have it
across browsers, and probably does not have it across Chrome patch versions.** §1.1, §1.2 and
§1.5. A design can respond by restricting the pairing — same engine, same build — and one of the
three designs did, honestly and with a 0.5 ms lobby fingerprint to enforce it. But the product
that restriction describes is: your friend, on your browser, on your patch version, this week,
with speed locked to 1×, where a disconnect freezes you and a desync ends the match with no
result. That is not worth several months.

**Two: the fix is shallow and named, and most of it is cheap.** Ban implementation-approximated
`Math` from simulation code and vendor one implementation into the bundle so the same bytes
execute everywhere. `tools/check-determinism.mjs:112` is the natural enforcement point and today
bans only `Math.random`, `Date.now`, `new Date` and `performance.now` — it says nothing about the
functions that actually break portability. **[V]** The single cheapest step is measured:
replacing `Math.hypot(a,b)` with `Math.sqrt(a*a+b*b)` cut Chromium-vs-Firefox divergent frames
over t+200 from **1,684 to 484** and **left every pinned checkpoint hash on all three battles
unchanged**. **[M: xengine]** No re-baseline, no balance read, and `sqrt` is the one function
IEEE-754 requires correctly rounded and that measured identical in every engine and both
architectures anyone tested. That is 71% of the exposure for a substitution.

**Three: the replay record is the precondition for every realtime option, is a shippable
single-player feature, and is the only instrument here that can catch the next regression.** A
record is the seed, the config token and the order log with each order stamped with its execution
tick. A human's 200-second battle is about **1.1 kB** compressed. **[M: async]** It gives you: a
save-and-share feature that works at population one; "take command from here", which falls out
for free because withholding the rest of the order log *is* taking over; a determinism gate that
drives real mouse input, records what that produces, and replays it — which fails on the day
someone adds a twenty-fourth out-of-band mutation, and nothing else in this project can notice.

**Four: if realtime is built later, build a relay, not peer-to-peer.** Not for NAT traversal. For
the total order. `applyOrder` iterates `o.unitIds` and mutates, so two orders touching one unit in
different sequence give different battles, and `deployment.add` → `spawnUnit` does
`nextUnitId++` before `rng.fork("unit" + id)` **[V]**, so a different interleaving of two
players' deployment ops gives different unit ids, different RNG streams and different pool
indices. Peer-to-peer needs a distributed tiebreak for both. A relay *is* the tiebreak: it stamps
`(turn, slot, index)` and that is canonical by construction. A Cloudflare Worker plus one Durable
Object per room code gives `idFromName(roomCode)` — a globally unique object reachable from
anywhere, placed near whoever opened the room. That routing guarantee is the primitive Vercel
Functions do not have at any price, and everything painful about the Vercel path (no instance
affinity, a Redis dependency, a 300 s connection cap on Hobby forcing two reconnects per
ten-minute battle) is downstream of its absence. **[M: transport]**

### 2.1 What I am explicitly not recommending

**Not "async is 80% of the value for a weekend".** It is not a weekend — see §5 — and it is not
multiplayer. Nobody is on the other end. The specific pleasure of a live opponent, that they are
*there*, reacting, right now, is exactly what a replay never supplies, and a dimmer line on a
strength graph does not substitute. The asynchronous pass said this about its own design and was
right to. What I am claiming is narrower and, I think, more useful: the replay record is worth
building **on its own merits**, it happens to be the thing every realtime option needs first, and
building it buys a month of evidence about cross-machine determinism at zero networking cost.

---

## 3. The staged plan

Each stage ships something usable alone, and each is a decision point.

### Stage 0 — Determinism hygiene. 4–6 days. Ships: a gate that can see the failure.

Nothing in this stage is speculative and none of it is wasted if multiplayer is cancelled.

1. **`Math.hypot` → `Math.sqrt(dx*dx+dz*dz)`** across `src/sim`, `src/ai`, `src/units`,
   `src/terrain`, `src/maps` and `src/city`. 248 sites at `66b220b`, of which **33 are
   three-argument** and need `sqrt(x*x+y*y+z*z)`. **[V]** Coordinates are bounded by
   `HALF_EXTENT = 1400`, so `hypot`'s overflow guard at ~1e154 buys nothing here. Expect no
   pinned hash to move; if one does, stop and find out why before re-recording.

   > **Done, 21 August 2026, at 249 sites — and the expectation in the line above is wrong for
   > the last 27 of them.** The second pass was `src/terrain` (11), `src/maps` (15, of which 12
   > in `src/maps/carthage/heightfield.ts`) and one regression in `src/city/rome/circuit.ts`.
   > `Math.hypot` now appears **nowhere** in `src/sim`, `src/ai`, `src/units`, `src/city`,
   > `src/terrain` or `src/maps`, so a hit anywhere in the linter's portability scope is a
   > regression rather than a backlog item, and the linter says so.
   >
   > **"Expect no pinned hash to move" held for the first 222 and failed for the last 27, and the
   > reason is the whole distinction this stage turns on.** Measured against the pins as they
   > stood, with nothing else changed:
   >
   > | battle | t+0 | t+30 | t+90 | t+150 | t+200 | t+250 | t+400 |
   > |---|---|---|---|---|---|---|---|
   > | field | unchanged | unchanged | **8,272 → 8,270** | 7,517 → 7,528 | 7,028 → 7,061 | 6,244 → 6,676 | 4,288 → 5,849 |
   > | Rome | unchanged | unchanged | **2,553 → 2,547** | 2,468 → 2,466 | 2,418 → 2,421 | 2,389 → 2,343 | 2,233 → 2,072 |
   > | Carthage | **hash only** | hash + `uf64` | **3,035 → 3,036** | 2,870 → 2,847 | 2,852 → 2,838 | 2,756 → 2,648 | 2,193 → 2,259 |
   >
   > The first 222 sites were in `src/sim`, `src/ai`, `src/units` and `src/city` — inside the
   > simulation, behind the float32 pool round trip, where a 1-ULP perturbation is absorbed. These
   > 27 are in **world generation**. They change the terrain by about a ULP, the terrain is the
   > ground the battle is fought on, and there is no firewall between a heightfield sample and a
   > man's footing. Two men at t+90 becomes fifteen hundred at t+400, which is what a chaotic
   > system does with two men.
   >
   > Carthage is the clean case and it says what kind of change this is: **t+0's pool hash moves
   > while `uf64` and `uctl` do not** — the roster, the orders and the discrete state are
   > untouched and the men have moved by a rounding step. And the direction is the point. The
   > value Chromium now computes is the value Firefox and WebKit were already computing; the pin
   > was recording Chromium's `hypot`, not the battle. **The pin moved because the pin was
   > engine-specific.** Re-recorded in the same commit, with the arm's before/after beside it.
   >
   > **The decision point below resolves half yes and half no, and the halves are different
   > problems.** It removed the Carthage t+0 split completely — three engines, one hash, zero of
   > 3,440 men differing, where before there were 838. It did not touch the field battle's
   > t+205.5 escape. Map generation decides the boot; the tick loop decides the battle. So
   > "cross-engine goes from dead to worth measuring properly" is right about boot portability and
   > wrong about whole-battle portability, and the road to the second one is *not* the vendored
   > libm this file points at — see the rewrite of Stage 3.
2. **Add the implementation-approximated `Math` functions to `BANNED` in
   `tools/check-determinism.mjs`**, and **add `src/city` and `src/terrain` to the default
   `SCOPE`** — the Carthage assault's t+0 divergence is in `src/city` and the linter has never
   looked there. **[V]**
3. **Move the hash into the product**: `src/sim/stateHash.ts`, imported by both the netcode and
   `qa-determinism.mjs` instead of injected as a string. Keep the existing arithmetic exactly
   (§1.7). Add a **float64 hash of `UnitGroupState`** beside it — 0.08–0.12 ms **[M×2]**, and it
   is the layer that sees divergence 6,000 ticks before the pool hash does. Exclude `grime` and
   the `lastCostMs` fields.
4. **Extend the gate past t+200.** Add t+300 and t+600 checkpoints. The escape is at t+205.5;
   the gate stops 5.5 seconds short of it.
5. **Add a cross-engine arm.** `firefox` and `webkit` are already in the Playwright cache and the
   harness already launches Playwright. Roughly twenty lines. It will go red on the Carthage
   assault immediately, which is the point.
6. **Add a cross-tier arm.** *Not in the original plan, and it should have been ahead of item 5.*
   **Built, `e/core/quality-sim-split`.** The same battle at `low`, `medium`, `high` and `ultra`,
   asserting the pool hash, `uf64`, `uctl`, headcount and unit count are identical at every
   checkpoint. On by default in `tools/qa-determinism.mjs`; `--tiers=off` skips it and says so.

   > **Why this belongs in front of the cross-engine arm.** Item 5 exists because two players on
   > two browsers compute `Math.sin` differently. This one exists because two players pick
   > different *tiers*, and until this pass the tier chose the size of the armies — so a match
   > desynced **at t+0, on army size, with both engines computing identically**, before a single
   > `Math` call had the chance to disagree. Note the mechanism precisely: there is no hardware
   > auto-detection in this game, the default is `ultra` for everybody, so the divergent tier
   > comes from a stored preference or from somebody on a weak machine turning it down — which is
   > exactly the player most likely to be invited into a match rather than hosting one. A
   > cross-engine arm run at one tier per machine would have reported that as a libm difference
   > and sent the next pass to Stage 3, which is priced at three to five weeks. It is also far
   > cheaper than item 5: one browser, three extra page loads, and the coupling is visible at t+0
   > before a tick has run.
   >
   > It is built so it cannot pass vacuously, which was the whole risk. Three of its four
   > assertions exist only to make the fourth mean something: the page must report the tier it was
   > asked for (read off `engine.quality.tier`, not assumed from the URL); at least one render
   > field must actually differ from the gate tier's, so four identically-configured runs agreeing
   > on a hash is not mistaken for tier independence; and `pool.capacity` and the effective
   > `unitSizeScale` are compared separately from the hashes, which is what caught `ultra`
   > carrying a 12,000-slot pool against `high`'s 10,000 while every hash matched. Only then does
   > the hash equality count for anything.
   >
   > While in the file: `--battle` is now **validated** rather than merely documented as a trap.
   > `--battle=rome` appended a meaningless `&rome`, loaded the default field battle, looked up a
   > baseline key nobody had recorded, printed "no baseline for this battle" and exited 0 — a
   > passing run that asserted nothing, with the headcount as the only tell. Every segment must
   > now be `key=value` with a key `src/` actually reads, or the run exits 2 with the three real
   > invocations printed.

   > **Built, 21 August 2026 — `tools/qa-xengine.mjs`, and it is not twenty lines.** It went red
   > on the Carthage assault immediately, exactly as promised, and then the sweep in item 1 turned
   > it green there. Twenty lines gets you a red light; what a cross-engine run is actually *for*
   > is which men and by how much, so the tool splits differing soldiers into an x/z population
   > and a y-only population — the pinned hash covers x/z/state/hp and cannot see foot height at
   > all — and localises the float64 unit layer by field name and ULP gap. That localiser is what
   > produced every number in the block at the head of §1.
   >
   > Two things the design did not ask for and the arm needed. **It is a separate tool, not an arm
   > inside `qa-determinism.mjs`.** Portability is not what an every-commit gate can fail on — the
   > same argument this document already makes for `uf64` being a warning — and twelve of fourteen
   > `Math` functions changed between two Chrome releases with no change to this tree. An arm that
   > reds every agent's gate on a browser update gets commented out. **And five of its six
   > assertions exist only so the sixth means something**, because a check that compares something
   > against itself is this project's most expensive recurring failure: the engine is established
   > by feature detection rather than the user-agent string, at least one `Math` function must
   > *actually* disagree between the engines before agreement on a battle hash is allowed to mean
   > anything, the probe's own `inputs`/`sqrt`/`a*b+c` controls must be identical everywhere, and
   > the reference engine is loaded **twice** so that anything reported is the libm rather than the
   > harness. That last one has already earned itself, refusing a whole result when two runs
   > overlapped on one port while the tree changed under them.

**Decision point.** If (1) removes the Carthage t+0 split, cross-engine goes from "dead" to
"worth measuring properly". If it does not, the vendored-libm question (Stage 3) is the only road
to cross-engine play and should be priced before anything realtime is started.

> **Resolved, and the second sentence's premise was false.** (1) removed the Carthage t+0 split
> outright — three engines, one hash, zero of 3,440 men differing. It did *not* touch the field
> battle's t+205.5 escape, so by the letter of this decision point the vendored libm was next.
> It was not: the escape is in the tick loop's own float64 unit state, and the fix is the
> firewall in `src/sim/quantise.ts`. Map generation decides the boot; the tick loop decides the
> battle; this decision point conflated them. See the reprice at Stage 3.

### Stage 1 — The replay record. 2–3 weeks. Ships: save, share, watch, take command.

> **Built, 21 August 2026 — `e/sim/replay-record`.** All six items below are in the tree.
> This block records what the building measured, including the four places it corrects this
> document and the two places it did something other than what was asked.
>
> **What shipped.** `src/sim/replay.ts` (the format, the codec and `ReplaySystem`, at order 5
> so its drain is the first thing in a tick), `src/sim/stateHash.ts` (Stage 0 item 3, which was
> never done and which this needed), `src/ui/ReplayBar.ts`, two buttons on the end card, and
> `tools/qa-replay.mjs` — **21 checks in nine arms**, booting through the front door
> with a real mouse. `?replay=<token>` watches; `&from=<seconds>` takes command.
>
> **The size estimate is right. 1,188 bytes.** Measured on a battle driven through the real
> menu with a real mouse: 226.1 s, 2,247 men, 32 recorded events (29 player orders and 3
> deployment operations — one order every 7.8 s, which is somebody actually playing), 9
> checkpoints. 2,726 B of JSON, **1,188 B gzipped**, a 1,584-character token that fits in a URL
> with room to spare. Scaled to exactly 200 s that is about 1,090 B against the design's
> **1.1 kB [M: async]** — inside 2%, from a completely different instrument. (Three runs of the
> same script recorded 32, 34 and 34 events and came out at 1,188 B, 1,219 B and 1,224 B; a real
> mouse does not click the same number of times twice.) Gzipped in isolation the split is config
> 476 B, order log 423–451 B, checkpoints ~246 B, so the **order log is 13.6–14.6 bytes an order**
> against
> §1.7's 11–13 B for a hand-rolled bit layout. The difference is JSON tuples rather than packed
> bits, and it buys a format readable in a debugger and versionable by appending. Note that a
> record is *not* only the order log: the config is 40% of it, because the menu keeps every
> order of battle a player has built and the token carries all seven so it is self-contained.
>
> **Item 4 was built and is not for what it says.** "A tick ceiling in `Time`, so the replay
> player cannot step past the next order's tick" describes a problem the record does not have:
> orders are keyed to a tick index and fed at the top of that tick from inside `fixedUpdate`,
> so a frame boundary has nowhere to put one. `Time.tickCeiling` exists, but for the *gate* —
> it is what makes `advanceTicks(n, stepMs)` run exactly n ticks, and without that a record and
> a replay on two frame schedules cannot be compared at all, only at two different tick counts
> that look like the same moment.
>
> **Item 5's deliberately-wrong arm is three arms, and one tick is enough.** An order shifted
> by **one** tick moves the pool hash at the next 30 s checkpoint. §3 item 4 quotes the async
> pass at "four ticks (133 ms) of lateness is already a different battle" — four is an upper
> bound, not the threshold. The other two arms are the ones that matter more: an unrecorded
> `orderIssued` emitted straight onto the bus mid-battle (the twenty-fourth input path,
> simulated), and a direct write to `UnitGroupState.width` from outside a tick (the shape of the
> bug §1.10 names at `SelectionController.ts:1538`). Both fork the battle and both are caught,
> by the product's own checkpoint comparison, without the tool comparing anything.
>
> **§1.6 is confirmed by a fourth instrument, and this is the strongest form of it yet.** A
> 6,783-tick battle carrying real recorded player input replays **bit-identically at 1000/6 ms
> (five ticks a frame) and at 1000/60 ms (one tick every two frames)** — pool, `uf64` and `uctl`
> at every checkpoint, and the same `BattleFlow.result`. The earlier cadence rigs measured a
> battle with no player in it; this one measures a battle whose orders arrived at frame
> boundaries that the two arms do not share. The three shipped comments §1.6 calls false are
> still in the tree and are now annotated rather than deleted, because their *advice* is right
> for the tool they sit in: `qa-determinism.mjs` drives by seconds, so coarsening its step does
> change the tick count and does move the hash. The stated mechanism was the wrong one.
>
> **The provenance field is not a precaution, it is load-bearing, and here is the number.**
> Over one 226-second recording the `orderIssued` bus carried **3,258 orders from the AI, 29
> from the player and 2 from the deployment phase**; the record has the 29. Without `source`
> a bus recorder captures all 3,289 and playback applies every AI order twice, because the AI
> regenerates its own from the same seed and the same state. §3 item 1 says this is why the
> stage is not two days, and it is right.
>
> **Four items of §1.10 are closed.** The gate's hash is in the product (`src/sim/stateHash.ts`,
> arithmetic unchanged to the bit — all three battles, all seven checkpoints, `hash`, `uf64` and
> `uctl` unmoved across the move). `orderIssued` carries `source: 'local' | 'ai' | 'deploy'`,
> **required**, so the compiler finds the sixteenth emit site; the fifteen the document counts is
> exactly right (seven in `SelectionController`, seven in `ai/Orders.ts`, one in `deployment.ts`).
> `SelectionController.ts`'s direct `u.width` write is deleted. `issueHalt`'s two `Siege`
> countermands now run at the top of the tick the halt lands on, still before `BattleSystem`
> hears it, so the documented ordering is not inverted.
>
> **Two things were done differently, on purpose.**
>
> *There is no build SHA, and the refusal is measured instead.* §3 item 6 wants the record to
> carry one and to refuse a foreign build "with a link to that build's immutable Vercel
> deployment". Nothing in this bundle knows its own SHA — `tools/deploy-vercel.mjs` uploads a
> static tree with no build step — so instead the record carries its checkpoint at tick 0 and the
> playback recomputes it. A build that changed the battle is refused by name at t+0, before a
> tick has run, which is a strictly stronger test of the thing the SHA is a proxy for. What is
> lost is the link, and the field is in the format for whoever adds a stamp.
>
> *Ordered positions are quantised in live play, not only in the record.* §4's Stage 4 warning —
> "round-trip your own orders through the codec … it is the commonest real lockstep bug and it
> appeared in none of the three designs" — was applied one stage early: `x`/`z` are snapped to
> int16 over ±1400 m (4.27 cm) at the moment an order enters the queue, so the number the
> simulation applies is the number the record carries, in both directions. This is a behaviour
> change to live play of 4.27 cm against a 0.72 m rank pitch. **It was worth it and the gate
> proved so on its first execution**, which found the bug twice in the deployment path: a
> right-drag placement recorded quantised and applied raw, and an absent coordinate encoded as
> zero, which stood a whole regiment at the world origin. Both showed as `uctl` matching
> perfectly while `hash` and `uf64` did not — the exact signature the document predicts. What
> would change my mind: a case where the 4.27 cm snap flips a `Siege.wallTargetAt` decision, in
> which case the raw float64 goes in the record and the round trip has to be found elsewhere.
>
> **The graphics tier is a simulation input, and the record carries it.** §1.10 already names
> the mechanism — `fittedUnitScale` fits the army to `quality.maxSoldiers` — and a measurement
> taken during this pass by the video pass sharpens it into an outcome rather than a headcount:
> Campus Martius assault, seed 4265438264, hard, **ultra 3,074 men and medium 3,009**, and at
> ultra the ram crew dies 16 m short of the door and lands nothing by t+520 while at medium it
> lands 26 blows and the Porta Flaminia opens between t+180 and t+240. Two different battles
> from a graphics setting.
>
> Verified here, because a record has to know what it must carry: **the tier reaches the
> simulation through exactly one field, at boot, and nothing else on the settings path reaches
> it at all.** `QualitySettings = SimQuality & RenderQuality`; `SimQuality` has one member,
> `maxSoldiers`; `Engine` freezes it at construction (`this.simQuality = Object.freeze(...)`)
> and re-asserts `q.maxSoldiers = this.simQuality.maxSoldiers` after *every* patch, so a
> mid-battle tier press cannot resize the army. Every read of `ctx.quality.*` in `src/sim`,
> `src/ai` and `src/units` is either `maxSoldiers` (thirteen sites, all in `BattleSystem.init`
> and the two `fittedUnitScale` calls in `scenario.ts`) or `lodFarDistance`, which is the
> impostor swap distance and is render-only. **[V]** So the record carries `quality`, the
> effective `unitScale` and `pool.count` at t+0; `?quality=` is applied *before* `?replay=` is
> decoded and the record's answer overwrites it; and a token claiming an army this run cannot
> field is refused by name. Two arms of the gate check exactly that.
>
> **[Annotated by `e/core/quality-sim-split`.** Every sentence of the paragraph above was true
> when written and its *scope finding* was independently re-verified — nothing on the settings
> path except `maxSoldiers` reached the simulation, plus two near-misses that look like leaks and
> are not: `Ragdoll.claimSlot` reads the camera inside a fixed step but is write-isolated from the
> pool, and `roughDrag` comes from `ObstacleField`, not from `grassDensity`. What has changed is
> the one field. `SimQuality` is deleted, `QualitySettings = RenderQuality`, and the pool is
> `SOLDIER_POOL_CAPACITY = 12000` at every tier, so the tier reaches the simulation through
> **no** field. The record still carries `quality`, `unitScale` and `count0`; the tier is now
> provenance and the `unitScale` refusal fires only on a *build* difference. One thing this
> paragraph did not find, and the cross-tier arm did: `pool.capacity` was a second leak, because
> `DeploymentSystem.headroom` gates every add during the deployment phase on
> `pool.capacity - pool.count`.**]**
>
> **What Stage 1 does *not* fix, and inherits.** `PLAYER_FACTION` is still a compile-time
> constant, so every record commands Rome. Pause and speed are still raw writes to the clock —
> harmless here, because a record is driven by tick index and a pause cannot displace an order,
> but still true. ~~And §7.5 stands unchanged: a record made at `high` is refused at `low` rather
> than silently fitted to a smaller army, which is the right behaviour and still a bad outcome.~~
> §7.5 is closed: a record plays at any tier, because no tier changes the army.


1. **Add provenance to `orderIssued`** — a `source: 'local' | 'ai' | 'deploy'` field, set at all
   fifteen emit sites. Without it a bus recorder captures the AI's orders and double-applies them
   on playback (§1.10). This is unavoidable and it is why this stage is not two days.
2. **Stamp and defer player orders.** Push player-sourced orders to a pending array drained at
   the top of `fixedUpdate`. **Player orders only** — one pass measured that routing the AI's
   orders through the same queue moves the shipped battle, because the AI emits inside
   `fixedUpdate` after `BattleSystem` has already run and `BattleFlow` sees its order the same
   tick. **[M: lockstep]** For player orders this is a behavioural no-op, since they already land
   after the frame's ticks.
3. **The three small edits**: delete the `u.width` write; fold `issueHalt`'s `Siege` mutations
   into the tick *without* inverting the documented ordering (§1.10); give
   `requestMachineOrder` its own record kind, since it is the one player command not on the bus.
4. **A tick ceiling in `Time`**, so the replay player cannot step past the next order's tick.
   Measured: four ticks (133 ms) of lateness is already a different battle. **[M: async]**
5. **`tools/qa-replay.mjs`, and it must drive the real mouse.** This is the deliverable that
   matters. Drive mouse and keyboard through the HUD the way `qa-interact.mjs` already does,
   record what that produces, replay it in a fresh page on a deliberately different frame
   schedule, and require bit-equality of the pool hash, the unit-state hash and
   `BattleFlow.result`. Include a deliberately-wrong arm — an order applied one tick late — so
   the gate proves it can see the fault it exists to catch. The passes' own probes synthesised
   events onto the bus, which proves the *simulation* replays but not that the *recorder*
   captures everything, and that second half is where the risk lives.
6. **The record format and the UI**: a compressed base64url token for short battles or a `.tcr`
   file, carrying build SHA, config token, effective `unitSizeScale`, `pool.count` at t+0, the
   order log, a checkpoint hash every 30 s, and `BattleFlow.result`. Refuse to play a record from
   a different build with a link to that build's immutable Vercel deployment. Refuse a quality
   tier that cannot hold the recorded army, rather than silently fitting a smaller one.

**Decision point.** If the mouse-driven gate is green for a week across the shipped battles, the
order layer is trustworthy and every realtime option is unblocked. If it is red, that is the
cheapest possible place to find out.

### Stage 2 — Challenge links. ~1 week on top of Stage 1. Ships: an asynchronous competitive mode.

Same seed, same config, same enemy, same ground; a rival's casualty curve as a second line on the
strength readout; a third column on the results panel. Verification is by replay, which makes
plagiarism self-defeating — replaying someone's log reproduces their score exactly and never a
better one — so the log need not be hidden.

Ship this only if Stage 1's record is actually being used. It is worth nothing at population one
and there is no evidence anyone but the owner wants it.

### Stage 3 — Two separable halves. The cheap one is one file and it is done; the 3–5 week one is not required on this tree.

> **Repriced 21 August 2026, from measurement. The two halves of this stage are separable, the
> cheap half is a single file, and on this tree the cheap half was sufficient.**
>
> This section bundles two things and prices them together: vendoring a software libm, and
> `Math.fround` on `UnitGroupState`'s integrated fields. Only the first is weeks. The second is
> `src/sim/quantise.ts` — quantise every float64 field `uf64` hashes to its nearest float32, at
> birth in `spawnUnit` and at the end of every tick from a system at order 60 — and it was
> written, measured and documented inside one session.
>
> **What it buys, measured with `tools/qa-xengine.mjs` on Chromium 151, Firefox 153 and
> WebKit 26.5, arm64 macOS, at `quality=high`, seven checkpoints to t+400:**
>
> | battle | men | before the firewall | after |
> |---|---|---|---|
> | default field | 8,632 | identical to t+200; apart at t+250 and t+400 — **5,849 / 5,560 / 5,886** survivors | **identical at all seven, all three engines** |
> | Carthage assault | 3,440 | identical t+30 onward; **t+0 `uf64` apart** — 26 float64 fields, all `facing`/`targetFacing`, 1 ULP, Firefox | **identical at all seven, all three engines** |
> | Rome assault | 3,072 | identical t+30 onward; t+0 `uf64` apart in *both* other engines | **identical at all seven, all three engines** |
>
> **Re-run in full on the merged tree, 22 August 2026, and the property survived the merge.**
> All three battles bit-identical in the same three engines at all seven checkpoints to t+400 —
> 8,632 / 3,072 / 3,440 men, `hash`, `uf64` and `uctl` — with 13 of 14 approximated functions
> measured disagreeing on every run, the `inputs`/`sqrt`/`fma` controls identical everywhere, and
> a second Chromium load bit-identical to the first. `simTime` is now a compared mark on all four
> runs of each arm, so "all 4 runs at t+0 … t+400 exactly, to the tick" is asserted rather than
> printed.
>
> The two firewall-off controls were re-taken at the same time, and they are what stop the row
> above being a table of things that were never going to fork:
>
>   - **Chromium against WebKit is still bit-identical at the Carthage boot with the firewall
>     off.** That pairing needs nothing beyond the `hypot` sweep, which is the measurement the
>     Stage 3 reprice rests on.
>   - **Chromium against Firefox differs at t+0 by exactly 26 float64 fields of 1,020** — 1 ULP
>     each, 13 `facing` and 13 `targetFacing` across 34 units, **zero** control fields and
>     **zero** of 3,440 men in the float32 pool. Reproduced field for field, a year and a tree
>     later, and closed by the `spawnUnit` half of the firewall.
>
> `hash`, `uf64` and `uctl` all three, exact bits, with the arm's own controls green: 13 of 14
> approximated `Math` functions measurably disagree between those engines on the same run, the
> probe's `inputs`/`sqrt`/`a*b+c` controls are identical everywhere, and a second Chromium load is
> bit-identical to the first so nothing above is harness noise.
>
> **Two things had to be right and only one of them is obvious.**
>
> *Order 60.* The firewall has to run after every writer of `UnitGroupState` in a tick. The two
> AIs sit at 42 and 45 and emit `orderIssued` **synchronously**, so their orders land through
> `BattleSystem`'s handler after `BattleSystem` itself has run. A firewall at order 15 would exist
> and do nothing, and the pool hash would hide that for thousands of ticks.
>
> *Birth.* `deployBattle` is called from `boot()` **after** `engine.initAll` returns, so a
> firewall that lives only in `fixedUpdate` — or in this system's own `init` — leaves the entire
> deployed order of battle unquantised at t+0. That was tried and measured: it left the Carthage
> assault's 26-field `facing` residual exactly where it was, because those values come from
> thirteen boot-time `Math.atan2(m.nx, m.nz)` calls in `deployAssault` and t+0 is hashed before a
> tick has run. Quantising inside `spawnUnit` closes it wherever a unit comes from. **t+0 is the
> checkpoint a lobby handshake and the replay record's refusal both key on, so getting the boot
> half wrong would have failed exactly the case a product needs.**
>
> **The intermediate measurement, which is the one that explains the mechanism.** With the
> firewall in `fixedUpdate` only and not at birth, the field battle still forked between t+200 and
> t+250 — but the divergence at t+400 fell from **289 men to 8**, and `uf64` went from differing
> at t+30 to agreeing through t+200. That is §1.4's amplifier being removed: `dx = tx - p.x[i]`
> differences a float64 unit target against a float32 soldier position and was measured at ~2,400×,
> and once `tx` is quantised it has no input difference to amplify. What was left was the
> un-amplified straddle rate, which is the same ~2e-9-per-write bound the pool has always had.
>
> **Five seeds, not one, because §7.2 cuts both ways.** An escape time is a sample; so is a
> *non*-escape, and one battle running identically in three engines could be a battle that was
> never going to fork. `tools/scratch/xe-seeds.mjs` builds a config token per seed
> (`sanitiseConfig` fills everything it is not given, so `{"seed": N}` is the default field battle
> with one thing changed) and runs the arm on each. Four extra seeds at 8,632 men, all three
> engines, t+0 / t+200 / t+400:
>
> ```
>   seed 11   4,586 survivors at t+400   identical in all three
>   seed 22   4,982                      identical in all three
>   seed 33   5,042                      identical in all three
>   seed 44   4,364                      identical in all three
>   shipped   4,785                      identical in all three, at all seven checkpoints
> ```
>
> **And the control is what makes that mean anything.** With the firewall switched off and nothing
> else changed, the shipped seed and seeds 11 and 22 all three go red between Chromium and Firefox
> — same seeds, same tree, one system removed. Without that arm, five seeds holding would be
> consistent with five seeds that were never going to fork. The control is **three of the five**,
> not all of them: the run covering 33 and 44 was started and then invalidated when the tree
> changed under it, and it refused rather than reporting a number — which is the second time the
> arm's own second-load control has caught me doing that in one session, and the reason it exists.
>
> **Those five seeds also price the cost better than the cost does.** Every pinned checkpoint on
> all three battles moves, re-recorded in the same commit as the change that moved them. The field
> battle's survivor curve, Chromium, before and after:
>
> ```
>          t+0    t+30   t+90   t+150  t+200  t+250  t+400
> before   8632   8632   8270   7528   7061   6676   5849
> after    8632   8632   8233   7207   6358   5980   4785
>                        −0.4%  −4.3%  −10.0% −10.4% −18.2%
> ```
>
> §3's one prior measurement of this put it at −1.1% at t+200. That was the tick-only half, on a
> different tree; the full firewall including the boot pass is **−10.0% at t+200 and −18.2% at
> t+400** on this one. **That is a change a player could notice and it must not be buried.** For
> scale: survivors at t+400 across the five seeds above span **4,364 to 5,042 — 678 men, 14.2% of
> the mean.** The change this makes to the outcome is the same order as changing the seed. That is
> not an argument that it does not matter — a battle is tuned at one seed — but it is the right
> frame, and it is a frame nobody had because nobody had run one battle at five seeds.
>
> The mechanism is still the small one. The quanta are far below anything visible — **0.12 mm** on
> a position against a 0.72 m rank pitch, **1.2e-7 rad** on a bearing, **6e-8** on a morale value
> in 0..1 — so this is **not "units move differently", it is "a few discrete decisions land the
> other way and the battle takes a different branch"**, and then twelve thousand ticks of a
> chaotic system amplify the branch. Someone reading this in six weeks needs to know it is a
> branch change and not a nerf. What it is *not* is evidence that the battle got worse, and
> nothing here measures that.
>
> **Re-measured on the merged tree, 22 August 2026, and the cost is materially smaller than the
> figure above.** The −10.0%/−18.2% pair was measured on the branch before it met `main`, and
> `main` had meanwhile moved the field battle's deployment onto its own ground and then widened
> both boxes east. Those changes moved the battle the firewall is a percentage *of*. Re-measured
> after the merge with `tools/scratch/firewall-toggle.py`, which is a save-and-restore rather
> than an edit-and-remember, the three-way decomposition on the field battle in Chromium is:
>
> ```
> survivors        t+0    t+30   t+90   t+150  t+200  t+250  t+400
> main's pin       8632   8632   8220   7384   6853   6310   4660    neither change
> + hypot sweep    8632   8632   8220   7348   6758   6412   5087    firewall toggled off
> + firewall       8632   8632   8252   7160   6304   5648   4973    this tree
>
> hypot alone                            -0.5%  -1.4%  +1.6%  +9.2%
> firewall alone                         -2.6%  -6.7% -11.9%  -2.2%
> both, vs main's pin                    -3.0%  -8.0% -10.5%  +6.7%
> ```
>
> So on this tree the firewall costs **−6.7% survivors at t+200 and −2.2% at t+400**, not −10.0%
> and −18.2%. Against the five-seed spread of 14.2% at t+400 measured above, the t+400 figure is
> now well inside seed noise and the t+200 figure is about half of it.
>
> **The control that makes the decomposition trustworthy is in the first two columns.** With the
> firewall off, this tree reproduces `main`'s pinned t+0 and t+30 hashes *exactly* — `0caf94c2`
> / `cf9e9e4e` and `3a315656` / `a54889bc`. The tree is therefore byte-identical to `main` at
> boot apart from the firewall, which is what entitles the middle row to be read as the `hypot`
> sweep alone.
>
> **And it is the reason the two commits must not be squashed.** The two effects are opposite in
> sign at t+400 (+9.2% and −2.2%) and they very nearly cancel: a single squashed commit would
> have reported +6.7% at t+400 and looked like a change that did almost nothing to a battle,
> when in fact one half moved it 9% one way and the other half moved it 2% back. `8c1ebca` and
> `5a1a439` are separate commits with separate parents on purpose, and `git revert 5a1a439` is
> the firewall alone.
>
> **It is a firewall, not a proof.** Quantising reduces the probability that two engines' answers
> straddle a rounding boundary to about 2e-9 per field per tick; it does not make it zero. The
> pool has always had exactly this bound and it held the pool for six thousand ticks. A battle
> long enough, or a seed unlucky enough, will still fork — and when it does, `uf64` now sees it,
> which is the second half of why this matters.
>
> **What would still change my mind.** A seed that forks with the firewall on; a fork appearing
> past t+400 on a longer run; or a human saying the battle plays worse. A 30-seed sweep, as this
> section already demands, is now cheap and is the obvious next measurement.
>
> **So the honest reprice.** The `fround` half: **one file, one session, measured, done.** The
> vendored-libm half: still 3–5 weeks, still carries all three unpriced costs this section names,
> and **is not needed for cross-engine play on this tree**. Reach for it only if a seed sweep finds
> forks the firewall cannot close, and then reach for the *cheapest subset* — the portability table
> ranks the functions, `hypot` is already gone from every scanned directory, and the 15
> `Math.pow(x, 2)` and `Math.pow(x, 3)` calls are the next free removal.

**Read the reprice above before the two halves below.** What follows is what each half is; the
blockquote is what the measurement says about whether you need it.

**Half A — the float32 firewall. `Math.fround` on `UnitGroupState`'s integrated fields, at birth
and at the end of every tick.** This is `src/sim/quantise.ts`: one file, 125 lines, most of them
prose, written and measured inside one session. It is the only half that turned out to be load-
bearing, and it is the whole of what removes the same-build constraint on this tree.

**Half B — vendored transcendentals.** One module implementing `sin`, `cos`, `tan`, `exp`, `log`,
`atan`, `atan2`, `asin`, `acos`, `cbrt` over exactly-specified operations, or a libm compiled to
WASM so the transcendentals ship in the bundle rather than coming from the engine. Still 3–5
weeks, and it still carries the three costs nobody priced: it will move every balance number that
has been tuned, requiring a full re-baseline in the same commit; it needs a performance
measurement first, because roughly 30,000 trig calls per tick through software implementations
could plausibly double a 3.4 ms tick; and it is a much larger behaviour change to three shipped
battles than half A already is.

**This section used to price them as one thing, and that was the expensive mistake in it.** The
old text said "one module … *plus* `Math.fround`", and everything downstream — §3's stage list,
the item-6 note that a cross-tier failure "would have sent the next pass to Stage 3, which is
priced at three to five weeks", §7.6 — read the whole stage as a single 3–5 week commitment
guarding a property nobody had measured. So the property was not measured for a year. The two
halves are separable, they are separable *in the code*, and the cheap one is sufficient here.

**What is actually needed, by pairing, and it is a handful of call sites rather than a libm:**

  - **Chromium ≡ WebKit: nothing at all beyond what has already landed.** After the `hypot`
    sweep the Carthage assault boots to one hash in both, with **zero of 3,440 men differing and
    `uf64` bit-identical** — before the firewall existed. That is §1.2's decade-old finding
    closed by removing 27 call sites of one function, not by vendoring anything.
  - **Firefox at boot: 13 call sites.** The residual after the sweep was Firefox alone and it was
    *named*, not inferred — 26 float64 fields of 1,020, all 1 ULP, all `facing` and
    `targetFacing`, from the boot-time `Math.atan2(m.nx, m.nz)` calls in `deployAssault`. Half A
    closes it by quantising in `spawnUnit`, which is one line and covers every unit however it
    was created. Writing a correctly-rounded `atan2` — and then being right about it forever —
    would have closed the same 13 sites for more money.
  - **All three engines, whole battle, to t+400: half A, and nothing else.** Five seeds, with a
    firewall-off control proving two of them fork without it.

**One gap this pass did not close, named rather than left to be found.** `stateHashes(pool,
units)` hashes the soldier pool and `UnitGroupState`. It does **not** hash `Siege` — gate
health, ram progress, ladder and tower occupancy, breach state — and `src/sim/Siege.ts` holds
float64 there with no quantisation step, which is the same shape of hole `uf64` was invented to
find. It is not a blindness so much as a delay: siege state drives orders and positions, so a
divergence in it reaches `uctl` and the pool hash eventually, exactly as an unquantised
`UnitGroupState` reached the pool hash eventually. Both assaults are bit-identical in three
engines at all seven checkpoints today, so nothing is currently wrong; what is missing is the
mark that would say so on the tick it stopped being true. A `usiege` mark beside `uf64` and
`uctl`, and `Siege`'s continuous fields added to the firewall, is the obvious next piece of
work and it is the same shape as the piece that just landed.

**What would send you to half B anyway.** A seed that forks with the firewall on; a fork
appearing past t+400 on a longer run; or a pairing this project has not measured — Chrome
130-x64 against Chrome 151-arm64 disagrees on `pow` for 10.5% of inputs, and `pow` is 0% across
the three engines here, so the three-engine result is a statement about *these* three builds.
And if you do go: reach for the **cheapest subset**, not the module. The portability table ranks
the functions, `hypot` is already gone from every scanned directory, and the 15 `Math.pow(x, 2)`
and `Math.pow(x, 3)` calls are the next free removal.

Do not start half B on the strength of one seed. Run a 30-seed sweep across two Chrome versions
first; the escape is a stochastic boundary-crossing process and one battle holding is not
evidence.

### Stage 4 — Realtime, if it is still wanted. 2–4 months part-time.

Cloudflare Worker plus one Durable Object per room, WebSocket Hibernation API
(`state.acceptWebSocket()`, not `ws.accept()`, which bills duration for the whole connection).
100 ms turns, 3 ticks each, 2 turns of delay giving 200–300 ms of input lag — inside the band Age
of Empires' playtesting measured as unnoticed. Immediate local acknowledgement of the order
marker, selection ring and voice line, which is presentation and free.

Cost, recomputed by me from the passes' own message counts because two of the three arithmetics
published were wrong: ~12,600 incoming messages per ten-minute 2-player match, billed at 20:1 =
**630 requests**, and 76.8 GB-s of duration. Free plan: 100,000 requests/day ÷ 630 = **158
matches/day**, and 13,000 GB-s/day ÷ 76.8 = 169 — so the binding constraint is requests, and one
design took the larger of the two. Paid at $5/month: 1,000,000 ÷ 630 = **~1,587 matches/month**,
not the 5,208 published. At 4× game speed the message rate quadruples and these fall to ~40/day
and ~400/month. **[V, arithmetic; M: transport for the inputs]** Whether Durable Objects are
available on the Cloudflare free plan at all is worth checking before relying on that row.

The static site does not change and `tools/deploy-vercel.mjs` is untouched.

What Stage 4 must not skip, drawn from the reviews:

- **Round-trip your own orders through the codec.** If the local peer applies its click at
  float64 while the remote applies the dequantised int16, that is a guaranteed desync on the first
  move order. It is the commonest real lockstep bug and it appeared in none of the three designs.
- **A late input must be deferred to the next open turn, not discarded.** One design closes the
  turn on a deadline and drops that peer's input — after the UI has already acknowledged it
  locally. That makes the acknowledgement a lie several times a match on any jittery link.
- **Hash the RNG fork states.** Seven live `Rng` streams, one u32 each **[V, M]**, free to send,
  and they catch "one peer rolled once more" on the tick it happens — which the pool hash needs
  thousands of ticks to see.
- **Decide what a hash mismatch means and be consistent.** In same-engine lockstep there is no
  mechanism for a *transient* disagreement, so any mismatch is a fork. A policy that tolerates one
  mismatch is protecting against a noise source the architecture says cannot exist.
- **Background tabs.** Chrome does not run rAF in a hidden tab, so a backgrounded peer stops
  sending and stops ticking while its socket stays open. It is indistinguishable from a stall
  unless something makes it distinguishable, and five minutes hidden is 9,000 ticks of catch-up.

---

## 4. The alternatives, and why they lost

### 4.1 Peer-to-peer deterministic lockstep — lost to the total-order problem, not to latency

Technically the closest to right, and the design that argued for it was the best-measured of the
three. It fails on two things a relay solves for free: there is no canonical order for two
players' orders arriving in different sequences on two machines, and there is no canonical order
for two players' deployment operations, which mint unit ids and pool slots. It also needs
signalling infrastructure anyway, at which point the signalling server may as well be the relay —
`idFromName(roomCode)` is the same primitive for both. TURN fallback is 10–25% of consumer
sessions and costs about $0.00014 per relayed ten-minute match on Cloudflare, so the money never
mattered; the complexity did.

### 4.2 Server-authoritative state sync — lost on bandwidth, before any other argument

5.5 Mbit/s per client at the most generous encoding anyone could construct, 253 Mbit/s naive
(§1.7), plus a machine that simulates, plus interpolation artefacts in exactly the melee this
project exists to render well. **[M×2]** This is the same wall Age of Empires hit in 1996 at 250
units; this game is at 8,632.

### 4.3 Vercel Functions as the transport — lost on instance affinity

Vercel Functions gained WebSocket support in June 2026 and this project already has Fluid compute
enabled, so it is technically available. It loses on four things, in order of severity: **new
WebSocket connections are not guaranteed to reach the same function instance**, and there is no
routing key, so two players in a match have no way to land on the same one (Vercel's own answer
is Redis pub/sub from the Marketplace — another service and another bill); Hobby's 300 s maximum
duration forces two reconnects per ten-minute battle, each of which re-rolls that dice; functions
run in `iad1` while the static site is served from the edge, adding ~66 ms to two west-coast
players who have a ~16 ms direct path; and `tools/deploy-vercel.mjs` uploads a pure static tree
with no build step, so emitting a function means a different deploy tool, not a flag. Also, Hobby
is non-commercial and exceeding a limit *pauses* the feature for 30 days rather than billing —
a traffic spike takes multiplayer offline for a month. **[M: transport]**

### 4.4 Rollback / GGPO — lost, but not for the published reason

The prior-art survey ruled it out with an 11.06 ms tick, making five ticks of re-simulation 55 ms
inside a 33 ms budget. That tick figure is a whole frame (§1.7). At the real 3.4 ms, five ticks
is ~17 ms in a 33 ms budget — tight, not absurd. What actually rules it out is that rollback needs
a snapshot *and* a restore every frame, and those are 9–14 ms and 4–7 ms (§1.8). That is the
budget gone twice over, on top of the re-simulation. Same conclusion, correct reason — and the
correct reason is the one that would not change if the sim got faster.

### 4.5 More than two players, reconnect into a live battle, and anti-cheat — all refused

Fan-out is not the problem; the desync surface, the slowest-peer coupling and simultaneous
deployment all scale badly. Reconnect needs the full snapshot of §1.8 shipped and maintained.
And lockstep of any shape hands both clients the entire world state. That is harmless *today* —
`UnitGroupState.concealed` exists, `AIWorld.ts:482` reads it, and it has no write site anywhere
in `src/` **[V]** — so symmetric full knowledge holds by accident. **The day woods or night
concealment ships, peer-to-peer becomes a maphack and multiplayer needs a simulating server.**
Bank that now.

---

## 5. Effort, honestly

Every design in this pass undercounted, and the reviews caught all three by a consistent factor:

| design | its own estimate | its reviewer's | ratio |
|---|---|---|---|
| lockstep | 4–6 weeks of evenings | ~14 weeks | 2.5× |
| relay | 8–11 weeks part-time | 4–7 months | 2.5× |
| async | 2.5–3 weeks | 5–7 weeks | 2× |

The pattern is not carelessness. It is that each design budgeted the piece it prototyped and
estimated the pieces it did not. The relay's snapshot was budgeted at 500 new lines and 65
changed lines against ~331 mutated instance fields across twelve systems. The lockstep design
named "the other 23 input paths" that break the deferral rule and budgeted 16 lines for two of
them. The async design's recorder was "subscribe and push", which the missing provenance field
makes false.

The estimates in §3 already have that correction applied. They are still estimates.

Two costs nobody put in a table. **A two-machine test rig**: localhost lockstep runs at 0 ms RTT
and passes while every real failure mode is invisible. Validating the latency budget, the
deadline policy, the reconnect window and background throttling needs two machines on two
networks and a link emulator, and every measurement in this entire pass is one machine. **And
the desync tail**: Supreme Commander's developer spent most of a week on one dangling pointer,
and Age of Empires debugged desyncs with 50 MB message traces and world dumps. Neither has an
honest estimate and Stage 4's "2–4 months" is the range before that tail, not including it.

---

## 6. What each pass measured, and what I did not reproduce

| pass | its strongest contribution | what I could not check |
|---|---|---|
| cross-engine | the t+205.5 escape, the Carthage t+0 split, the perturbation ladder, the `hypot` ablation | I did not re-run any browser. The ladder and the ablation rest on one rig. |
| determinism audit | independent confirmation of the three Carthage t+0 hashes; the twelve-way single-function bisect naming `hypot`; the `t+0` rAF race in the gate | ditto |
| orders | the 24-input census, the tick-alignment sweep, the `fittedUnitScale` table | verified the code citations, not the runtime numbers |
| transport | Vercel's constraints, Cloudflare pricing, the latency table, the state-sync bandwidth ladder | the RTT measurements are from one machine on one link |
| prior art | the literature, and the nudge-magnitude sweep with a clean wrapper control | its 11.06 ms tick figure is a frame, not a tick — do not carry it forward |
| lockstep design | the cadence-invariance rig, the Chrome 149→151 result, the `fround` prototype | one seed per battle, two versions, one machine |
| relay design | **snapshot-and-resume works**, and the four traps it found | one pass, three battles, one seed each, and the shipping serialiser is a different object |
| async design | record sizes, the stamped-replay equivalence run, the "take command from here" idea | its headline cadence table claims up to 8.9 ticks per frame against a hard `maxStepsPerFrame = 5`, which cannot be true as printed — the *conclusion* is independently confirmed four times over, but that table is not usable evidence |

Things I re-derived myself at `66b220b`, all listed as **[V]** above: the tick-count off-by-one
(`/tmp/tc-tickcheck.mjs`); the Cloudflare match arithmetic; the `Math.*` call-site census; the
`orderIssued` topology and its missing provenance field; `grime`'s two writers; the gate's hash
covering only x/z/state/hp from one `chromium.launch()`; the linter's banned list and its scope
excluding `src/city`; ten `fixedUpdate` bodies, all inside the scanned scope; `MODS`/`SIGNALS` at
module scope; `concealed` having no write site; `PLAYER_FACTION` at 31 references in 8 files; and
that the two assault baselines were re-recorded between the pass's pin and `66b220b`.

That last one matters. The passes pinned `3595b48`; this checkout is 34 commits past it, and
`tools/determinism-baseline.json` has moved: Carthage assault t+0 `dbdd3a70` → `ade40cb0`, Rome's
assault t+0 `22bb3df8` → `55a19c06`. **[V]** The commit that moved them touched wall geometry and
gate apertures — the same masonry code that produces Carthage's cross-engine t+0 split. So the
lockstep design's two siege reassurances (Carthage identical across Chrome 143–151 to t+600, and
identical again with `fround`) were measured on a battle that no longer exists. **Half the
cross-version evidence expired inside the review window**, which is its own argument for putting
a cross-engine arm on the gate rather than in a document.

---

## 7. Open risks

**7.1 The premise that decides the product is unmeasured.** Every number in this pass is one
machine. Cross-*engine* determinism is thoroughly established as broken, but that is not the risk
a same-engine product runs. The risk is Chrome-on-Alice against Chrome-on-Bob: two machines, same
version, possibly different CPUs. V8 ships its own fdlibm port so same-version V8 across
architectures is *plausibly* bit-exact, but that is a hypothesis, and one pass measured system
JSC arm64 disagreeing with its own x86-64 slice on 1,315 of 8,192 `sin` results. The cheapest
close is an afternoon with a second machine and the boot-hash handshake.

**The `chrome130-x64` half of this is false and was checked, 21 August 2026.** This paragraph used
to end "and a `chrome130-x64` build is already sitting in the Playwright cache — a same-day
cross-architecture read that nobody ran." Nobody ran it because it is not there:
`chromium-1140` in this cache reports Chrome 130.0.6723.31 and its binary is
`Mach-O 64-bit executable arm64`, single-architecture, not a universal build and not an x86-64
slice. Every Chromium in the cache is arm64. **There is no cross-architecture read available on
this machine at any price**, and an afternoon planned around that sentence would have been spent
discovering so. The cross-architecture question needs a second machine exactly as much as the
two-machine question does — which makes §7.1 one measurement rather than two, and a strictly
larger job than it looks.

**7.2 The escape time is a sample, not a constant.** t+205.5 is one seed, one army size, one
tier, one machine. The mechanism is a stochastic boundary-crossing process, so a different seed
escapes at a different time and some seeds will not escape inside ten minutes at all. It is the
*existence* of the escape that is robust — it was measured mechanically, not just observed. Do
not quote 205.5 as a property of the game.

**7.3 The snapshot result is n=1.** Three battles, one seed each, one machine, one engine. Treat
"the snapshot is complete" as a strong single result, not an invariant — and note that a rewind
gate is only as strong as the states its overlay battle happens to reach. It will not exercise a
gate opening, a ram at the wall, a burning tower or a unit mid-escalade, which are exactly the
rare siege states where a resync is most visible.

**7.4 Records rot.** Pinning to immutable Vercel deployment URLs works and costs nothing, but a
six-month-old challenge plays a six-month-old game and any ranking resets whenever balance moves
— which, judging by this file's own history, is often. This weakens the "Stage 1 ships value
regardless" argument, though not fatally: watching your *own* battle back is unaffected.

**7.5 A laptop is excluded from the thing being shared. — CLOSED, `e/core/quality-sim-split`.**
The risk was that until army size was separated from render tier in the menu's model, a record
made at `high` could not be watched at `low` without becoming a different battle, so the people
most likely to be watching rather than playing were the ones locked out. Army size is now
separated from render tier: the soldier pool is `SOLDIER_POOL_CAPACITY`, the tier buys resolution,
shadows, post-effects and LOD distance and nothing else, and a record plays identically at any
tier. `ReplaySystem.play`'s refusal is kept and is now unreachable by a tier mismatch — it fires
only when the *build* fits a different scale for the same config, which is the case where a
silent substitution would be worst. `qa-replay.mjs`'s `tier-in-record` arm asserts the new
behaviour and its `tier-refused` arm still proves the refusal fires, using a tampered token.

What is *not* closed: a laptop that cannot render 8,632 men now renders 8,632 men badly rather
than 1,515 men smoothly. That is the correct trade — a smaller battle is a battle-size decision
and belongs to the player, not to a shadow-quality dropdown — and the lever for it is the menu's
battle-size row, which is a `BattleConfig` field, travels in the `?battle=` token and is carried
by every record. It is a worse *default* on weak hardware than the accident it replaces, and that
is a defaults question for the owner rather than something to fix by putting the coupling back.

**7.6 Stage 3 may not be worth its own price. — HALF OF IT IS DONE AND THE OTHER HALF IS NOT
NEEDED HERE.** This paragraph said vendoring transcendentals "is the only road to cross-engine
play", and that a bad performance number meant the honest answer was no cross-browser
multiplayer at all. Both statements were wrong, and they were wrong because this file priced
Stage 3's two halves as one thing. The road to cross-engine play on this tree was the *other*
half — `Math.fround` on the float64 unit layer, one file — plus 27 `Math.hypot` call sites, and
all three battles now run bit-identically in Chromium 151, Firefox 153 and WebKit 26.5 over five
seeds with a firewall-off control proving it. The vendored libm still moves every tuned number
and might still double the tick cost; it is simply not what was standing between this game and
cross-browser play. See the reprice at Stage 3.

**7.7bis The tier was a second portability firewall, and it was not made of floating point. —
CLOSED, `e/core/quality-sim-split`.** §7.1 frames the pairing risk as libm: Chrome-on-Alice
against Chrome-on-Bob, same version, possibly different CPUs. There was a larger and much cruder
breach in front of it. The graphics tier fixed `quality.maxSoldiers`, `fittedUnitScale` fitted the
army to it, and the field battle therefore booted 8,632 men at `high` and 1,515 at `low`
**[M×2]** — and the Campus Martius assault at one seed was 3,074 men at ultra against 3,009 at
medium, with the ram crew dead 16 m short of the gate at one tier and the gate open by t+240 at
the other. **[M: video]** Two players who accepted their own defaults on different hardware were
simulating different armies before a single `Math` call had the chance to disagree, and no amount
of Stage 3 would have fixed it.

The owner ruled on it — *"definitely graphics settings should not change outcome of battle"* — and
it is fixed at the source rather than papered over in a handshake: `SOLDIER_POOL_CAPACITY = 12000`
in `src/sim/types.ts`, one number at every tier on every machine, `SimQuality` deleted,
`QualitySettings = RenderQuality`. `low` and `medium` now field the `high`/`ultra` battle; `high`
and `ultra` did not move, and all 21 pinned baseline checkpoints are bit-identical across the
change. The invariant is held by a gate arm rather than by this paragraph: Stage 0 item 6.

Two things survive the fix and a lobby still owes them a handshake. A pairing must exchange the
**effective `unitSizeScale` and `pool.count`** rather than the tier name, because the *build* and
the *battle-size config* can still move them even though the tier cannot. And §7.1's libm risk is
untouched — it was always the smaller of the two and it is now the only one left.

**7.7 The social modes are a population bet with no evidence behind them.** Stage 1 has real
single-player value and I have leaned on that deliberately. Stages 2 and 4 are worth nothing at
population one, and nothing in this pass measured whether anyone besides the owner wants either.

---

## 8. One-paragraph summary

> **Amended 21 August 2026.** Two of the three sentences that open this paragraph are no longer
> true of the tree. Three engines run **all three** battles bit-identically through **every**
> checkpoint including t+400, on five seeds, and the shipped battle that used to be a different
> battle in three engines before a tick ran now boots identically in all of them. What did it was
> not the vendored transcendental library this document budgets three to five weeks for: it was
> removing the last 27 `Math.hypot` calls from map generation, which closed the boot, and giving
> `UnitGroupState` the float32 quantisation firewall the soldier pool has always had, which closed
> the battle — one file, one session, at a cost of −10.0% survivors at t+200 that the owner has to
> ratify. What has *not* changed: this is still one machine (§7.1), and a firewall still only makes
> a fork rare rather than impossible. The Chrome-update risk is also smaller than §1.5 said and
> differently shaped — the unit is a libm *generation*, `{130} {143,147,149} {151,152}`, so a
> pairing handshake should exchange a fingerprint rather than a version string.

Three engines run the default battle bit-identically through every checkpoint this project pins,
and diverge 5.5 seconds after the last one; one shipped battle is a different battle in three
engines before a single tick runs; and a routine Chrome update ended a ten-minute battle 42%
apart. Deterministic multiplayer across browsers does not work here today. The cause is named —
implementation-approximated `Math`, a float32 firewall in the soldier pool that holds for 6,000
ticks, and a float64 unit layer with no firewall and no hash — and the cheapest 71% of it is a
`Math.hypot` substitution that changes no pinned hash. So: spend a week making the gate able to
see the failure, then two or three weeks on the replay record, which is a feature on its own, the
precondition for every realtime option, and the only instrument here that can catch the
twenty-fourth input path when someone adds it. Then re-decide, with a cross-engine arm on the gate
and a month of real evidence, whether a relay-mediated two-player battle is worth two to four
months. It might be. Nothing measured here says it is impossible; quite a lot says it is not yet
ready to be started.

---

## 9. Stage 4, built — the relayed session, 21 August 2026, `e/net/session`

> **This section supersedes §2's recommendation and part of §4.5.** §2 said do not build realtime
> yet. The owner heard that and overrode it, and this is what got built. §2's *argument* is still
> the right one, and two of its four steps have since been closed by other passes — the
> `Math.hypot` sweep and the replay record — so the thing §2 was protecting against is smaller
> than it was. What has *not* changed is §7.1: every number below is one machine, and
> Chrome-on-Alice against Chrome-on-Bob remains unmeasured.

**What runs.** Two browsers, one relay, one battle. Both players come through the front door,
choose or receive a battle, lay out their own army with the mouse on a stopped clock, and fight
it. Measured on `campus-martius` / field / small / high by `tools/qa-net.mjs`:

```
tick 1953    pool 04886122 / 04886122     both clients
             uf64 4735aae8 / 4735aae8
             uctl fc1c061d / fc1c061d
            alive 2287 / 2287             of 2,337 men
             18 relayed events, byte-identical merged order log on both clients
```

### 9.1 The shape, and the three decisions inside it

**Lockstep with a relay-scheduled input delay.** §4.4's rejection of rollback stands and its
corrected reason is the one that matters: a snapshot at 9–14 ms and a restore at 4–7 ms is a
33 ms budget gone twice over before any re-simulation, and that would still be true if the tick
got faster. What made lockstep cheap here is that Stage 1 had already built the hard half — an
order log keyed to a tick index, drained at the top of that tick, with `x`/`z` quantised at the
moment the order is issued. **The netcode did not need a wire format. It reuses
`encEvent`/`decEvent` from `src/sim/replay.ts` verbatim, and the relay never decodes one.**

Three rules, and everything else follows:

1. **Nothing a client does reaches its own simulation until it has been round-tripped.**
   `ReplaySystem` in `net` mode diverts every order, every siege-machine command and every
   deployment verb to the relay and applies only what comes back.
2. **A client may not simulate past the last turn it has.** `Time.tickCeiling` — added for the
   replay gate — is set to `turnTick(readyTurn + 1)` every frame.
3. **Wall clock is a pacing device and never reaches the simulation.** It decides when the relay
   closes a turn and how fast a client may catch up (`time.gameSpeed`, which scales the
   accumulator and not the step). The turn packet decides *what* runs and *at which tick*.

**The relay orders; the client stamps.** A turn packet carries opaque tuples sorted by
`(slot, seq)` plus the execution tick `turnTick(n)`. That split means the relay knows nothing
about the order format — the day the format changes, the relay is not a second thing to migrate —
and it means the input delay is a pure relay-side policy that **cannot cause a desync**. Latency
policy and determinism are decoupled, which is the single most useful property of the design.

**One `Room`, two hosts.** `src/net/room.ts` is a pure state machine with no I/O in it.
`tools/relay.mjs` (Node, ~90 lines of hand-rolled RFC 6455, no dependencies) and `net/worker.ts`
(a Cloudflare Worker plus one Durable Object per room code, `state.acceptWebSocket()` for
hibernation) are both thin adapters over it. Node 24 strips types from a `.ts` import, so all
three consumers read the same file and the protocol cannot drift. **The Worker has never run** —
there is no Cloudflare account here and `wrangler` is not a dependency — and `net/wrangler.toml`
exists so that deploying it is one command rather than a research task.

### 9.2 The turn grid, and why 3 ticks and 2 turns

`TICKS_PER_TURN = 3` (100 ms at 30 Hz) and `DEFAULT_DELAY_TURNS = 2`. An op received during turn
*n* is scheduled at `max(n + 1, n + delay)`, so the budget is roughly *worst round trip through
the relay ≤ 200 ms*. 3 divides 30, so a turn boundary is always a tick boundary and
`turn * TICKS_PER_TURN` is exact.

**There is no drop path.** No per-slot deadline, no discard. Turns close on the relay's own clock
and a late op lands in the next open turn — one `Math.max`. §3's review named the opposite
behaviour, closing a turn on a deadline and dropping that peer's input after the UI has already
acknowledged it, as "a lie told several times a match on any jittery link". Lateness here costs
latency and never a command.

### 9.3 What the delay costs, measured

`tools/qa-net.mjs --only=lag`, three artificial one-way delays on the relay, orders issued through
real mouse events and timed from the click to the tick the order executed on:

| one-way | round trip | input delay | stalls | stalled |
|---|---|---|---|---|
| 0 ms (localhost) | 146 / 153 / 146 ms | **3.5 / 3.7 / 3.0 ticks — 117 / 122 / 100 ms** | 0 / 0 / 0 | 0 / 0 / 0 ms |
| 25 ms | 180 / 228 / 175 ms | **4.0 / 7.0 / 4.2 ticks — 133 / 233 / 139 ms** | 0 / 2 / 0 | 0 / 222 / 0 ms |
| 60 ms | 229 / 240 / 232 ms | **5.7 / 6.0 / 5.5 ticks — 189 / 200 / 183 ms** | 0 / 0 / 0 | 0 / 0 / 0 ms |

Three runs, all reported, because the spread between them is the instrument and not the link: the
orders are issued by a real mouse against a real HUD, so *which* 100 ms turn a click lands in is
timing this gate does not control, and the middle run was taken while six other agents' Playwright
runs had the machine's load average over 100. Take the shape rather than the digits — **an input
delay of 100–120 ms on a free link, rising to about 185 ms at a 232 ms round trip**, and the
battle never waiting on the network at all in the two quiet runs.

**The floor is 3 ticks and it is the assertion that matters.** An order cannot execute sooner
than the start of the next scheduled turn, so anything below 3 would mean an order had reached
the simulation *without going through the relay* — the one failure this design cannot survive,
and one a hash comparison would not necessarily catch, because two clients that both apply an
order locally in the same frame look identical until their frames stop lining up. The ceiling is
softer: an op that arrives after a turn boundary lands a turn later, and the client's own tick may
trail the relay's counter by another, so 7 to 9 ticks is legal under latency and the gate refuses
above 12.

A stall is *waiting longer than one and a half turns for a packet*, not merely sitting on the
ceiling. The first version of that metric counted every frame at the ceiling and reported 93
stalls totalling 12.6 s of a 13 s battle on a zero-latency link, which is true and useless:
lockstep at real-time pacing spends most of its wall clock waiting by construction. Zero stalls
at a 229 ms round trip is the number that means something.

### 9.4 What happens on a desync: **halt, attribute, and end with a stated result**

Not resync. §1.8 found the simulation *can* be snapshotted, so resync was genuinely on the table,
and two things took it off — the second is decisive.

The first is cost: the shipping serialiser is not the reflective probe that proved §1.8, and that
pass's own reviewer counted 331 mutated instance-field names across twelve systems, with 162
`private` declarations in `Siege.ts` alone. It is a larger piece of work than this whole session
layer. The second is that **it would not help**. §4's review is right that in same-engine lockstep
there is no mechanism for a transient disagreement, so any mismatch is a fork — and a fork here
has exactly one cause, two libms that do not agree, which is a *systematic* property of the
pairing rather than an event. Resyncing would hand both clients the same state and they would
fork again on the next contested tick, for the same reason, for as long as anyone kept pressing
the button. A resync repairs a lost packet; there are no lost packets under TCP, and every op is
acknowledged by being echoed back in a numbered turn.

*What would change my mind:* a measured **transient** — two clients disagreeing at one checkpoint
and agreeing at the next without intervention. That cannot happen under the architecture as
described, so observing one would mean the architecture is not what this section says it is, and
finding out which part is wrong would matter more than the policy.

**The detector is `uf64`, and the choice is configurable.** Both clients send a checkpoint every
30 ticks — one simulated second, about 0.25 ms of work — carrying the pool hash, `uf64`, `uctl`
and the survivor count, and the relay compares them at equal ticks. `uf64` is asked about first
because it has no quantisation firewall and moves thousands of ticks before the float32 pool hash
does: measured cross-engine, t+30 against t+200. Which layers are *fatal* is a relay flag
(`--fatal=uf64,uctl,pool,alive`) rather than a constant, because which layer deserves to be the
detector changed twice on the day this was written.

**Attribution.** On a mismatch the relay asks both clients for per-unit `uf64` digests at that
tick — 35 units × one 32-bit hash, about 300 bytes — and broadcasts the differing unit ids. Each
digest is hashed from a fresh state rather than folded into the next, so a one-regiment fault
names one regiment instead of every regiment after it. Clients keep twelve checkpoints of digest
history, because a desync is declared about a round trip after the tick it happened at.

**Survival.** Both clients halt at the diverging tick; the panel names the tick, the layer, the
two hashes and the regiments; the result is the one at the last *agreed* checkpoint; and both
sides still hold a complete `.tcr` record of the match, which is the forensic artefact that makes
the next desync cheaper to find. It never hangs and it never continues.

### 9.5 Pairing is a table, not a flag — and the table is now permissive

The answer moved **three times in one day**, which is the whole argument for the mechanism.
Morning: "same build only", on all three engines diverging by t+250 and Chromium and Firefox
ending 289 men apart. Evening: a `Math.fround` firewall on `UnitGroupState`'s integrated fields
makes Chromium and WebKit bit-identical to t+400. Night: the same firewall measured across **all
three engines, all three battles, seven checkpoints t+0 to t+400, five seeds** — with a control,
because switching the firewall off and changing nothing else turns two of the five seeds red. So
the property is real, attributable to one change, and asserted by a gate rather than believed.

A binary policy would have been wrong twice before it was right once. `DEFAULT_PAIRS` in
`src/net/protocol.ts` is a dated list with the evidence on each row; `tools/relay.mjs --pairs=`
and `--unknown=refuse|allow` override it without a deploy.

**The default is now `unknown: 'allow'`, and that is a deliberate inversion.** It was `refuse`.
Once every measured pairing held for a whole battle, the balance of errors flipped: refusing a
pairing that would have worked became the likelier and the worse mistake, and the cost of being
wrong the other way is a match that ends inside a second with the tick, the layer and the
regiments named. `--unknown=refuse` restores the strict posture for anyone who would rather not
start than not finish. The gate checks **both** postures, because the mechanism is the thing that
has to keep working while the policy moves.

**`exact` is a fingerprint, and it must never become a version string.** Measured across eight
Chromium builds, the fourteen approximated functions fall into *generations* that do not track
the version number:

| step | functions that differ |
|---|---|
| 130.0.6723.31 → 143.0.7499.4 | 1 of 14 — `pow` |
| 143.0.7499.4 → 147.0.7727.15 | **0** |
| 147.0.7727.15 → 149.0.7827.55 | **0** |
| 149.0.7827.55 → 151.0.7922.34 | **12** — `tan atan2 acos asin exp sin cos log log1p expm1 atan cbrt` |
| 151.0.7922.34 → 152.0.7977.8 | **0** |

Three generations: `{130}`, `{143, 147, 149}`, `{151, 152}`. One of them spans six major
versions. A version check would refuse pairings that work perfectly and accept the one that does
not. A generation **is** a fingerprint equivalence class, so `exact` — an identical `libm` hash
over ~2,000 results from integer-generated inputs, with `sqrt` and `a*b+c` as controls, about
0.5 ms in the lobby — already means "same generation", with no build-number table to maintain and
no way for it to go stale. An unknown build is not refused; it is fingerprinted, and if it lands
in a known generation it plays.

The handshake also compares the sanitised config, the **effective `unitSizeScale` and
`pool.count` rather than the tier name** (§7.7bis), and the product's own t+0 checkpoint — a real
check rather than a proxy that always fails, because the `Math.hypot` sweep closed every
cross-engine t+0 split.

**A correction to §7.1.** It says a `chrome130-x64` build is in the Playwright cache for a
same-day cross-architecture read. It is not: `chromium-1140`'s binary is Mach-O arm64 and every
Chromium in that cache is arm64. The cross-architecture question cannot be answered on this
machine, and the eight-build sweep above is a sweep over libm generations, not over
architectures. §7.1 needs two physical machines and remains open.

### 9.6 Two players, two deployment phases

`deployment.add` → `spawnUnit` runs `nextUnitId++` **before** `rng.fork('unit' + id)`, so two
players' deployment operations interleaved differently mint different unit ids, fork different
RNG streams and take different pool slots. There is no local-prediction path that survives that,
so **deployment operations are relayed like any other order and applied only when they come
back**, in canonical order, on both clients. The cost is one round trip of lag on a placement, in
a phase where the clock is stopped; locally that is about a millisecond.

Each machine runs **two** `DeploymentSystem` instances, one per commanding slot, because
everything in that class is bound to a faction — the zone is measured off where the *other* army
stands, the roster comes from `rosterFor(playerFaction, …)`, `headroom` counts against it, and
the bench is per side. The clock is released by the second player to commit, not the first.

`PLAYER_FACTION` is no longer a compile-time constant. §1.10 listed it as a defect — *"the second
player cannot be anything but Rome"* — and the fix is `const` → `let` plus one setter, because ES
module bindings are live and all thirty-one reads follow with no other edit. Two rules come with
it, both enforced by where the setter is called from: set once, before the HUD is built; and
**nothing in `src/sim` may read it**, which is what lets the two clients of one battle hold
different values and still run the identical simulation.

### 9.7 The gate, and every failure it can produce on purpose

`tools/qa-net.mjs` drives two browsers through the real menu with real mouse events. Six of its
eleven arms exist to go red, and each of those fails if the session does *not* notice.

> **Two browsers, not two contexts of one — changed 22 Aug 2026.** The first version booted both
> clients as two pages of a single Chromium, which would have satisfied the cap in
> `tools/lib/browser-budget.mjs` while costing the machine two renderer processes, two WebGL
> contexts and two full battles. `check-browser-budget` names that gap itself under *not
> covered*: "a tool that takes one slot and then opens ten contexts inside it." This gate holds
> **two of the four slots**, and three under `--only=xengine`.

| arm | what is broken | what happened |
|---|---|---|
| `battle` | nothing | same tick, same four hashes, byte-identical merged order log, same result, delay inside 3–6 ticks, no console error |
| `siege` | nothing — **a relayed assault** | §9.11 |
| `proto` | nothing | the room state machine over a real socket, headless, in two seconds |
| `drop` | one order removed from one client's turn packet | caught at tick 90 on `uf64`, 2 of 37 units named |
| `dup` | one **deployment** operation delivered twice | caught at **tick 0** — before a tick of battle — 2 of 38 units named |
| `swap` | two same-slot orders in one turn exchanged | caught at tick 90 on `uf64`, 2 of 37 units named |
| `ulp` | one `UnitGroupState` float64 field moved by **1 ULP** on one client | caught at tick 60 on `uf64`, **1 unit named** |
| `late` | a third client joins mid-battle | refused: *"room … is already in its battle phase"* |
| `leave` | one client's socket closes | survivor told `peerLeft` at a stated tick, and stops |
| `lag` | 0 / 50 / 120 ms round trip | the table in §9.3 |
| `xengine` *(opt-in)* | nothing — **Chromium against Firefox** | §9.8 |
| `net-coverage` | *(not an arm — a check on the run)* | red unless the run relayed both a field battle and a siege |

**Ten arms run by default; `xengine` is opt-in** (`--only=xengine` or `--all`). It runs two
full-scale battles in two browser engines at once, and Firefox software-rendering 8,632 soldiers
is the most expensive thing in this repository — on a shared machine, with six other agents'
Playwright runs putting the load average at 144, it times out on `page.goto`. **A gate that goes
red because the laptop is busy teaches people to ignore it.** Cross-engine determinism is
`tools/qa-determinism.mjs`'s question and it asserts it against pinned hashes; what this file
uniquely owns is the session, and the `ulp` arm covers detect-attribute-end with a real one-ULP
fault for nothing.

Two findings from building those arms are worth more than the arms themselves, and both are
corrections to things this document asserts loosely.

**A duplicated *move* order is harmless, and that is measured rather than assumed.** `applyOrder`
writes `targetX`/`targetZ`, clears the waypoints and re-plants the hold point, and doing that
twice with the same numbers leaves the same state — so the first `dup` arm passed by proving
nothing. Retargeting it at a deployment operation turned it into the sharpest arm in the set. Do
not read this as "duplication is safe": it is safe for *that verb*, and a shift-queued order
appends a waypoint.

**A `swap` of two orders on *different* regiments is also harmless**, because `applyOrder` mutates
only the units an order names, so disjoint orders commute. §4.1's claim is precisely about two
orders touching **one** unit, and the arm had to be made to produce that case — three right-clicks
inside 75 ms on one selection — before it could go red. An arm that swapped any two ops would
have passed while demonstrating the opposite of what it claimed.

### 9.8 Chromium against Firefox: a divergence nobody chose

The best fixture available, and better than the injected one-ULP poke, because nothing about it
was chosen by the test. On the 8,632-man field battle at this commit — **which does not carry the
`Math.fround` firewall** — Chromium and Firefox part company at:

```
tick 30, t+1.0 s, on uf64:  89693b58 against d748c81e
last agreed tick 0
4 of 35 regiments differ: 0, 4, 6, 26
both clients ended
```

One second. The float64 unit layer has no firewall, which is exactly what §1.4 says and exactly
what the detector was chosen for. **Both outcomes are handled the same way, and that is the
point** — the session does not need to know which build it is in, and the arm's pass condition is
two-sided by design: agree, or disagree *and be detected, attributed and ended*. Only silence
fails it. That is what lets this arm survive the merge with the firewall, which turns it from a
guaranteed red into a guaranteed green.

**Two things about running it.** It is opt-in, for the load reason above. And its two
diagnostics — the frames each socket has seen, and the tick ceiling each client is holding — are
in `NetStatus` and on the in-battle strip, because a lockstep client that has stopped has stopped
for one of two very different reasons (nothing arriving, or something arriving it has not got
round to) and nothing else on screen tells them apart. Both were added because this arm reported
a correctly-detected divergence as a failure and that was the question which resolved it.

**Which is also why it stops being the desync fixture.** With the firewall, Chromium, Firefox and
WebKit agree to t+400 on five seeds, so there is no longer a natural divergence to point the
detector at, and the injected `ulp` arm becomes the primary one. The better successor is the one
the firewall itself makes available: **a client booted with quantisation disabled, playing a
client with it on.** That is a real divergence from real floating-point disagreement, at a time
and place nobody chose, and once `src/sim/quantise.ts` is in the tree it is a URL flag on one
client and a fifth row in the table above. It is not built here because that file is on another
branch.

Two things this run corrected in the instrument, both worth recording because both would have
produced a confident wrong answer:

- **The first version compared hashes wherever the two clients happened to be** and read 7,846
  ticks against 7,848 as a cross-engine divergence. It was two ticks of a battle. The relay's own
  comparison — which *is* at equal ticks — had said nothing, and the disagreement between the two
  instruments is what caught it.
- **The first version had nobody commanding either army.** With both player factions uncommanded
  and no orders issued, 8,632 men stood still for 262 simulated seconds, nobody died, and the two
  engines agreed perfectly. The escape §1.1 measured comes out of *combat*; a battle with no
  orders in it is two armies standing in a field. The arm now runs `?autoplay=1`, so both armies
  are under an AI whose plan is derived from the config and the seed and is therefore the same
  plan on both clients.

And one honest non-result: the same pairing on a **2,337-man** battle ran bit-identically to
t+300. That is a real measurement and it is *not* evidence that the pairing holds; §7.2 says the
escape is a stochastic boundary-crossing process, so a quarter of the men is roughly a quarter of
the chances.

### 9.9 What was deliberately left out of "functional"

Named rather than forgotten. Each was considered and refused with a reason.

1. **Reconnection into a live battle.** §4.5 refused it and this pass has not revisited the
   refusal, because it needs the §1.8 snapshot serialiser — the 331-field, twelve-system,
   permanently-taxed object §5 says every design in the pass underestimated. What is built
   instead is a legible failure: a dropped socket ends the match by name at a stated tick on both
   sides. A socket dropped in the *lobby* reopens the slot, which is the useful behaviour.
2. **More than two players.** §4.5, unchanged. The desync surface, the slowest-peer coupling and
   simultaneous deployment all scale badly, and `Room` is written for two slots throughout.
3. **Anti-cheat.** §4.5, unchanged, and lockstep hands both clients the whole world by
   construction. Harmless today because `UnitGroupState.concealed` still has no write site
   anywhere in `src/`; **the day woods or night concealment ships, this becomes a maphack.**
4. **Client-side prediction, even cosmetic.** There is none, not even an order marker. At 117 ms
   of delay a marker that appears when the order actually lands is a truthful interface; one that
   appears instantly is a lie about three frames in five, which is the shape §3's review
   objected to. If it feels bad in play, the honest fix is a distinct *sent* state on the marker,
   not a predicted one.
5. **Pause and game speed as shared controls.** Speed is now the session's own rate-matching
   lever and pause is not relayed, so pressing either affects only the local client's *pacing*
   and never its tick count. A player who pauses falls behind and catches up at up to 8×; one who
   is more than 300 turns (30 s) behind ends the match as `abandoned`, because 9,000 ticks of
   catch-up is a second failure rather than a recovery (§3, background tabs).
6. **A deployed relay.** `net/worker.ts` and `net/wrangler.toml` are written and have never run.
   §3's arithmetic — ~630 billed requests and 76.8 GB-s per ten-minute match, so ~158 matches a
   day on the free plan with requests as the binding constraint — is unverified, as is whether
   Durable Objects are on the free plan at all.
7. **A second machine.** §7.1 is still open and is still the premise the product rests on. Every
   number in this section is two browsers on one laptop. A relay makes closing it easy: two
   machines, one `node tools/relay.mjs`, and the boot-print handshake will either agree or name
   the field that does not.
8. **The lobby form itself is not clicked by the gate** *(stated 22 Aug 2026)*. The host goes
   through the real front door and the real setup sheet; the challenger opens the invite URL —
   `?net=<relay>&room=<CODE>&host=0`, which is exactly and only what `NetLobby.ts:132-139`
   builds and puts on the clipboard. So the *join path* is the product's, but nobody has typed a
   room code into the form under test. Everything downstream of that URL is covered; the text
   input, the Create/Join buttons and the clipboard write are not.

### 9.10 Where the code is

| file | what |
|---|---|
| `src/net/protocol.ts` | the wire, the turn grid, `BootPrint`, the pairing table, `libmPrint` |
| `src/net/room.ts` | the room state machine, pure, shared by both relay hosts |
| `src/net/NetLink.ts` | the socket, and the pre-boot lobby exchange |
| `src/net/NetSession.ts` | the client: ceiling, catch-up, checkpoints, desync policy |
| `src/ui/NetLobby.ts` | make a room or join one; `?mp=1`, and a plaque on the front door |
| `src/ui/NetPanel.ts` | who you are, what the link is doing, and what went wrong |
| `tools/relay.mjs` | the Node relay, dependency-free, with the fault injector |
| `tools/qa-net.mjs` | the gate: two clients in two browsers, eleven arms, six of them negative |
| `net/worker.ts`, `net/wrangler.toml` | the Cloudflare target, written, never run |

Changes outside `src/net`: `src/sim/replay.ts` gains a `net` mode and exports its codec;
`src/sim/deployment.ts` gains a relay hook, a peer and a settable name; `src/sim/stateHash.ts`
gains `unitDigests`; `src/ui/theme.ts` makes `PLAYER_FACTION` settable; `src/ui/HudSystem.ts`
guards the deployment teardown against the peer's phase; `src/ui/DeploymentPanel.ts` stops
flashing an empty refusal; `src/ui/MainMenu.ts` gains one plaque; `src/main.ts` wires it together.

**How to run it, on one machine:**

```
node tools/relay.mjs                       # ws://127.0.0.1:5959
npm run dev                                # or any vite on a port that is yours
open http://127.0.0.1:<port>/?mp=1         # create a room, copy the invite, open it in a
                                           # second window
node tools/qa-net.mjs                      # the gate
```


### 9.11 The blind spot the gate inherited, and what closing it found — 22 August 2026

`e/net/session` was written on 21 August and interrupted by a machine crash before it was
integrated. This section is what happened when it was picked up: it was merged onto a `main` that
had moved under it, and then pointed at the one battle it had never played.

**The merge.** Two things on `main` were newer than the session branch and both had to win.
Rome's determinism pin moved to **3,072** at `63be5cd`, so the branch's `3,074` was simply out of
date — `tools/determinism-baseline.json` did not conflict and no pin moved. And `npm run lint` is
**3/3** now: `check-browser-budget` fails any file in `tools/` that opens a browser without going
through `tools/lib/browser-budget.mjs`, and `tools/qa-net.mjs` had two direct launches.

**Two clients are two slots.** The obvious conversion — one `launchBrowser`, both clients as two
pages inside it — passes the cap and is a lie. Two pages are two renderer processes and two WebGL
contexts running two battles; the budget's own lint says so under *not covered*: "a tool that
takes one slot and then opens ten contexts inside it." The host and the challenger now take a
slot each, so the gate holds two of four and anything else on the machine queues behind it rather
than oversubscribing it. A third slot is taken by `--only=xengine`'s Firefox.

While moving them, one ordering bug fell out that had nothing to do with the cap.
`browser-budget.mjs` installs its own `uncaughtException` handler when it takes a slot, and node
runs those listeners in registration order. `qa-net.mjs`'s `cleanup()` — the function that kills
the relays — was registered *after* the first launch, behind a handler ending in
`process.exit(1)`. It was dead code on precisely the paths it existed for. It is registered
before the first resource now. `tools/relay.mjs` also learned `--parent=<pid>`, polled every two
seconds, the lesson `tools/lib/vite-runner.mjs` learned the same week: SIGTERM only helps when
something is alive to send it, and the event this machine has actually had is everything on it
being SIGKILLed at once.

#### The blind spot

**Every arm in this file booted `campus-martius / field`.** That is the same hole that let
`tools/qa-replay.mjs` report 21/21 for weeks while no siege record had ever been through it, and
it was written into this file on the same day that hole was found in the other one.

It matters more here. A siege is where this design's hazards are densest — `Siege.ts` mutates
private maps outside the tick, a wall and a gate and a ladder queue are control flow that `uctl`
is the only layer watching — and the challenger *never sees a menu*. Its entire battle, siege
included, arrives as `MsgSetup.cfg` over the relay. Nothing above would ever have said whether a
siege config crosses the wire and builds identically on both clients.

**It does.** `campus-martius / assault`, two clients, real menu, real mouse, both armies deployed
and fighting:

```
tick 1365 (t+45.5 s), 3,180 men, 3,072 alive on both
pool  caa88bc8 / caa88bc8
uf64  d62dcbaa / d62dcbaa
uctl  50c56120 / 50c56120
last agreed checkpoint 1350;  17 order events, byte-identical on both clients
```

#### What closing it found

**A disabled button, and a thirty-second hang.** `deployWith` clicked the first deployment row's
`+`. On the assault the establishment is fixed and `tower-assault` ships that button *disabled*,
so Playwright waited thirty seconds and threw a locator name — on the challenger, taking the arm
with it. This is the second time this repository has paid for it: `tools/lib/menu-boot.mjs`
carries a long comment about a bare click on a disabled button stopping `qa-replay`'s matrix arm
dead on its second battle. The driver now takes the first row whose `+` is *enabled* and records
the skip when there is none, and `.dep-begin` is asked rather than clicked blind.

The identical unguarded line was still sitting in `tools/qa-replay.mjs:293`. It has never fired
because the `matrix` arm passes `deploy=0` — so it is a latent hang waiting for the first person
who gives that arm a deployment phase. Fixed in the same style; behaviour on a field battle is
unchanged, because there row 0 is always addable.

**`net-coverage`, and it goes red.** A siege arm that somebody later narrows or deletes would take
the coverage with it and the green count would not move. So the run now asserts what it covered:
`covered` is filled from the **challenger's** own config on every match — not from the arguments
this file passed, because recording the argument would prove nothing and recording what the second
client built proves the config crossed the relay. A run containing both the `battle` and the
`siege` arm must contain at least one `field` and at least one `assault`.

Made to fail on purpose, which is the only reason to believe it:

```
$ node tools/qa-net.mjs --only=battle,siege --siege-scenario=field
  FAIL  net-coverage   no relayed assault in this run —
                       covered: campus-martius/field, campus-martius/field
  ✗ 14/15 checks passed        exit 1
```

`--siege-scenario` is a real knob rather than a test hook — it points the arm at any `(map,
scenario)` the product ships — but it is spelled out rather than hard-coded to `assault`
specifically so that the check guarding the coverage claim can be shown to work.
