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

### 1.5 A routine Chrome update is as dangerous as a different browser

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
- **`maxSoldiers` is frozen at Engine construction** and excluded from `AdaptiveQuality`'s patch
  list, so a mid-battle quality change cannot resize the army. Each peer can run its own render
  tier. **[M×2, V]**
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
- **The quality tier silently changes the army.** `fittedUnitScale` fits the army to
  `maxSoldiers`: the field battle boots 8,632 men at `high` and 1,515 at `low`. **[M×2]** `high`
  and `ultra` are bit-identical — `Math.min` binds on the asked scale long before the pool cap —
  so ultra buys 2,000 pool slots and not one more soldier. Any pairing must pin the *effective*
  `unitSizeScale`, not the tier.
- **The gate's hash lives in the harness, not the product.** `window.__poolHash` is a string
  injected by `tools/qa-determinism.mjs`. **[V]** No FNV constants appear anywhere in `src/`.
  This is the project's recurring failure mode: the capability is in the instrument.

---

## 2. The recommendation

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

**Decision point.** If (1) removes the Carthage t+0 split, cross-engine goes from "dead" to
"worth measuring properly". If it does not, the vendored-libm question (Stage 3) is the only road
to cross-engine play and should be priced before anything realtime is started.

### Stage 1 — The replay record. 2–3 weeks. Ships: save, share, watch, take command.

> **Built, 21 August 2026 — `e/sim/replay-record`.** All six items below are in the tree.
> This block records what the building measured, including the four places it corrects this
> document and the two places it did something other than what was asked.
>
> **What shipped.** `src/sim/replay.ts` (the format, the codec and `ReplaySystem`, at order 5
> so its drain is the first thing in a tick), `src/sim/stateHash.ts` (Stage 0 item 3, which was
> never done and which this needed), `src/ui/ReplayBar.ts`, two buttons on the end card, and
> `tools/qa-replay.mjs` — **20 checks in eight arms, 20/20**, booting through the front door
> with a real mouse. `?replay=<token>` watches; `&from=<seconds>` takes command.
>
> **The size estimate is right. 1,188 bytes.** Measured on a battle driven through the real
> menu with a real mouse: 226.1 s, 2,247 men, 32 recorded events (29 player orders and 3
> deployment operations — one order every 7.8 s, which is somebody actually playing), 9
> checkpoints. 2,726 B of JSON, **1,188 B gzipped**, a 1,584-character token that fits in a URL
> with room to spare. Scaled to exactly 200 s that is about 1,090 B against the design's
> **1.1 kB [M: async]** — inside 2%, from a completely different instrument. (Two runs of the
> same script recorded 32 and 34 events and came out at 1,188 B and 1,224 B; a real mouse does
> not click the same number of times twice.) Gzipped in isolation the split is config 476 B,
> order log 423 B, checkpoints 245 B, so the **order log alone is 14.6 bytes per order** against
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
> **What Stage 1 does *not* fix, and inherits.** `PLAYER_FACTION` is still a compile-time
> constant, so every record commands Rome. Pause and speed are still raw writes to the clock —
> harmless here, because a record is driven by tick index and a pause cannot displace an order,
> but still true. And §7.5 stands unchanged: a record made at `high` is refused at `low` rather
> than silently fitted to a smaller army, which is the right behaviour and still a bad outcome.


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

### Stage 3 — Vendored transcendentals. 3–5 weeks, and unpriced by every design in this pass.

One module implementing `sin`, `cos`, `tan`, `exp`, `log`, `atan`, `atan2`, `asin`, `acos`,
`cbrt` over exactly-specified operations, or a libm compiled to WASM so the transcendentals ship
in the bundle rather than coming from the engine. Plus `Math.fround` on `UnitGroupState`'s
integrated fields at the end of each tick, to give that layer the firewall the pool already has —
one pass measured a 20-line version of this holding the field battle identical across Chrome 143
and 151 all the way to t+600, where the shipped code diverges by t+300. **[M: lockstep, one seed
per battle]**

This is the only work that removes the same-build constraint, which is the largest cost to the
player in any realtime design. It also has three costs nobody priced: it will move every balance
number that has been tuned, requiring a full re-baseline in the same commit; it needs a
performance measurement first, because roughly 30,000 trig calls per tick through software
implementations could plausibly double a 3.4 ms tick; and the `fround` half is a behaviour change
to a shipped battle (−1.1% survivors at t+200 in the one measurement taken).

Do not start this on the strength of one seed. Run a 30-seed sweep across two Chrome versions
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
close is an afternoon with a second machine and the boot-hash handshake, and a `chrome130-x64`
build is already sitting in the Playwright cache — a same-day cross-architecture read that nobody
ran.

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

**7.5 A laptop is excluded from the thing being shared.** Until army size is separated from
render tier in the menu's model, a record made at `high` cannot be watched at `low` without
becoming a different battle — so the people most likely to be watching rather than playing are
the ones locked out. An explicit refusal is the right behaviour and is still a bad outcome.

**7.6 Stage 3 may not be worth its own price.** Vendoring transcendentals moves every tuned
number in the game and might double the tick cost. It is the only road to cross-engine play, and
if the performance measurement comes back badly, the honest answer is that this game does not get
cross-browser multiplayer, and Stages 0–2 are what it gets instead.

**7.7bis The tier is a second portability firewall, and it is not made of floating point.**
§7.1 frames the pairing risk as libm: Chrome-on-Alice against Chrome-on-Bob, same version,
possibly different CPUs. There is a larger and much cruder breach in front of it. The graphics
tier fixes `quality.maxSoldiers`, `fittedUnitScale` fits the army to it, and the field battle
therefore boots 8,632 men at `high` and 1,515 at `low` **[M×2]** — and the Campus Martius
assault at one seed is 3,074 men at ultra against 3,009 at medium, with the ram crew dead 16 m
short of the gate at one tier and the gate open by t+240 at the other. **[M: video]** Two
players who accept their own defaults on different hardware are simulating different armies
before a single `Math` call has had the chance to disagree, and no amount of Stage 3 fixes it.
Any realtime pairing must exchange and pin the **effective `unitSizeScale` and `pool.count`**,
not the tier name — §1.10 says the same thing about `high` and `ultra` being identical, which
is true and is not the general case. The replay record does this already and refuses a mismatch
by name; a lobby would have to do the same in its handshake.

**7.7 The social modes are a population bet with no evidence behind them.** Stage 1 has real
single-player value and I have leaned on that deliberately. Stages 2 and 4 are worth nothing at
population one, and nothing in this pass measured whether anyone besides the owner wants either.

---

## 8. One-paragraph summary

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
