# Simulation and determinism

How the battle simulation actually works, for a developer who has never seen this codebase.

Everything below was checked against the source at commit `6698e19`. Where a number is
quoted it is either read directly out of the code (file and line given) or measured by a
probe run against that commit, and said to be so. Where a claim in the code's own comments
turned out to be wrong, that is said too — see [Known defects](#known-defects-and-gaps) at
the end, which is the part of this document most worth reading twice.

This is *not* `docs/ARCHITECTURE.md`. That file is a contracts document written for coding
agents: subsystem interfaces, invariants, budgets. It tells you what you may not break. This
one tells you how the thing works.

---

## 1. The shape of a frame

The whole simulation is a list of subsystems driven by one loop. There is no ECS, no job
graph, no worker thread. `Engine.frame` (`src/core/Engine.ts:396`) runs, in this exact
order:

```
time.beginFrame(nowMs)      -> returns N, the number of fixed steps owed
input.beginFrame(...)
N x  { for each subsystem in order: fixedUpdate(1/30, ctx) }   <- the simulation
     for each subsystem in order: update(scaledDt, ctx)        <- visual only
     rig.update(...)  camera is final after this
     for each subsystem in order: preRender(ctx)               <- interpolation happens here
     renderer.render(...)  (or renderOverride, which PostFX installs)
```

Note that N may be **zero**. At a 60 Hz display with the sim at 30 Hz, `ticksThisFrame`
alternates 1, 0, 1, 0. Half of all frames run no simulation at all and render an
interpolated view of the previous two ticks.

`Subsystem` is declared at `src/core/Engine.ts:33`. A system is resolved by name through
`ctx.get('battle')`; systems never import each other's instances, and they communicate
either through the typed `EventBus` (`ctx.events`) or through a shared blackboard module.
`order` decides update sequence; `Engine.add` re-sorts on every insertion
(`src/core/Engine.ts:325`).

### The tick order that matters

Every simulation subsystem's `order`, read off the source:

| order | `name` | file |
|---:|---|---|
| 10 | `battle` | `src/sim/BattleSystem.ts:428` |
| 20 | `combat` | `src/sim/Combat.ts:338` |
| 25 | `projectiles` | `src/sim/Projectiles.ts:713` |
| 30 | `morale` | `src/sim/Morale.ts:251` |
| 35 | `abilities` | `src/sim/Abilities.ts:75` |
| 40 | `pathfinding` | `src/ai/Pathfinding.ts:1120` |
| 42 | `tactical-ai` | `src/ai/TacticalAI.ts:862` |
| 45 | `general-ai` | `src/ai/GeneralAI.ts:261` |
| 46 | `ai-debug` | `src/ai/AIDebug.ts:38` |
| 50 | `battleFlow` | `src/sim/BattleFlow.ts:173` |
| 120 | `ragdoll` | `src/sim/Ragdoll.ts:122` |

Two of these orderings are load-bearing and neither is obvious:

- **`tactical-ai` (42) runs *before* `general-ai` (45)** on purpose. The tactical layer
  therefore executes the plan the general made on the *previous* tick. One tick of command
  latency, 33 ms, and the reason given (`src/ai/index.ts:20`) is that it is "slightly more
  honest than an army that reacts within the same instant its commander thinks".
- **`battleFlow` (50) runs after `morale` (30)** so that a rout registered this tick counts
  toward the result in the same tick (`src/sim/BattleFlow.ts:174`).

`Siege` is *not* a subsystem. It is owned by `BattleSystem` and called at two precise points
inside the soldier tick, because it has to run between steering and integration
(`src/sim/BattleSystem.ts:461`). The siege volume covers it.

---

## 2. The fixed-timestep loop

`src/core/Time.ts` is 121 lines and is worth reading in full. The simulation runs at a fixed
**30 Hz** (`fixedDt = 1/30`, line 13); rendering runs as fast as the display allows.

### The accumulator

`beginFrame(nowMs)` (`src/core/Time.ts:49`) does five things:

1. Differences `nowMs` against the previous raw timestamp and **clamps the delta to
   [0, 0.25] s** (line 57). A backgrounded tab or a long GC pause must not teleport the
   battle.
2. Scales by `gameSpeed`, or by zero when paused, into `scaledDt` (lines 60-61). *Game speed
   scales the accumulator input, never the step size* — which is exactly why determinism
   survives 1x, 2x and 4x: the sim only ever sees `dt = 1/30`.
3. Drains the accumulator in whole `fixedDt` steps, at most `maxStepsPerFrame = 5` of them
   (lines 63-67).
4. **Sheds the backlog**: if the accumulator is still above `fixedDt * 5` after the loop, it
   is clamped down to `fixedDt * 5` (lines 69-71). This is the death-spiral guard. It means
   the simulation *loses time* rather than accumulating an ever-growing debt it can never
   pay off.
5. Publishes `ticksThisFrame`, `tick`, `simTime` and `alpha = accumulator / fixedDt`.

`gameSpeed` is clamped to [0, 8] by `setSpeed` (line 89); the HUD binds 1x, 2x and 4x
(`src/ui/HudSystem.ts:587-595`) plus pause.

### `alpha`, and where interpolation actually happens

`SoldierPool.savePrevious()` (`src/sim/types.ts:540`) is called at the top of every fixed
step and copies `x, y, z, facing` into `px, py, pz, prevFacing`. The renderer then lerps:

```ts
// src/sim/BattleSystem.ts:2800
renderPos(i, alpha, out) {
  out.x = p.px[i] + (p.x[i] - p.px[i]) * alpha;   // and y, z
}
renderFacing(i, alpha) {
  return p.prevFacing[i] + wrapAngle(p.facing[i] - p.prevFacing[i]) * alpha;
}
```

Interpolation happens in **`preRender`**, not `update` — because `preRender` runs after the
camera is final, and the unit renderer needs the final camera for culling and LOD in the
same pass it computes positions. There are exactly three consumers of `time.alpha`:
`src/units/UnitRenderSystem.ts:2000`, `src/sim/Projectiles.ts:2856` and
`src/ui/Banners.ts:469`.

**`alpha` is documented as being in `[0,1)` and is not.** `Time.alpha`'s doc comment
(`src/core/Time.ts:23`) says "Interpolation factor in [0,1)". The step ceiling makes that
false: once `scaledDt` exceeds `maxStepsPerFrame * fixedDt = 1/6 s`, the while loop stops at
five steps with the accumulator still full, and the backlog clamp then parks it at exactly
`fixedDt * 5` — so `alpha` becomes exactly **5.0** and `renderPos` *extrapolates* soldiers
five ticks (167 ms) beyond where the simulation has put them.

Measured against the real `Time` class (5,000 frames per row, synthetic timestamps):

| frame pacing | max steps | max `alpha` |
|---|---:|---:|
| 60 fps, 1x | 1 | 0.99999999999999978 |
| 144 fps, 1x | 1 | 0.99999999999998213 |
| 30 fps, 1x | 2 | 0.99999999999999978 |
| 60 fps, 4x | 3 | 0.99999999999999956 |
| 30 fps, 4x | 5 | 0.99999999999999789 |
| **24 fps, 4x** | 5 | **1.0000000007** |
| **20 fps, 4x** | 5 | **5.0** |
| **5 fps, 1x** | 5 | **5.0** |

The threshold is arithmetic, not empirical: the ceiling binds when a frame's *scaled* delta
exceeds 166.67 ms, which is a 6 fps frame at 1x, 12 fps at 2x and **41.7 ms — 24 fps — at
4x**. At 1x this is a stall nobody will see the result of anyway. At 4x it is reachable on a
loaded machine, and the visible symptom is soldiers sliding ahead of themselves and snapping
back. Nothing clamps `alpha` at any of the three consumer sites.

### `Engine.advance`, and why `rebase` and not `resync`

`Engine.advance(seconds, stepMs = 1000/60)` (`src/core/Engine.ts:493`) runs synthetic frames
flat out with no display pacing them. Every headless tool in the project reaches a battle
state through it.

It feeds `frame()` a monotonically increasing synthetic timestamp seeded from
`time.elapsed`, and it must re-baseline the clock first, because `elapsed` is a cumulative
sum of *clamped* deltas while `lastNow` holds the previous *raw* timestamp. Those are two
different clocks that diverge the moment anything clamps. Before the re-baseline was added,
`advance(1e-6, 1e-3)` moved the battle about 0.13 s rather than one microsecond
(`src/core/Engine.ts:506`) — because the first synthetic frame's delta pinned at the 0.25 s
clamp and fired all five steps.

The re-baseline is `Time.rebase` (`src/core/Time.ts:118`) and **not** `Time.resync`
(line 105), and the difference is the whole point:

```ts
resync(): void { this.accumulator = 0; this.lastNow = -1; }   // drops sub-tick debt
rebase(nowMs?): void { this.lastNow = nowMs === undefined ? -1 : nowMs / 1000; }
```

`resync` also zeroes the accumulator. If `advance` used it, then N short advances would stop
being equivalent to one long advance, because each short advance would throw away whatever
fraction of a tick was left over. Determinism tests compare exactly that equivalence.

I measured it. Driving the real `Time` class through `advance`'s own logic:

```
one advance(10 s):                    ticks = 299   simTime = 9.966667
ten x advance(1 s), using rebase:     ticks = 299   simTime = 9.966667
ten x advance(1 s), using resync:     ticks = 290   simTime = 9.666667
```

Nine ticks — a third of a second of battle — silently lost, once per boundary. That is the
bug `rebase` exists to prevent, and it is the reason the two functions are not the same
function with a flag.

`advance` also calls `rebase()` with no argument at the end, which makes the next real frame
a zero-delta baseline. Without it, the live rAF loop's first `performance.now()` would be
differenced against a synthetic value and land on the 0.25 s clamp.

Finally, `advance` sets a private `advancing` flag that suppresses the adaptive-quality
controller (`src/core/Engine.ts:466`), because a synthetic frame's wall clock says nothing
about whether a player would have seen a dropped frame.

---

## 3. The soldier pool

`SoldierPool` (`src/sim/types.ts:429`) is a structure of arrays: 37 parallel typed arrays,
all allocated once at battle start to `quality.maxSoldiers`.

### Why SoA

Two reasons, and the second is the one people forget:

1. At 6-10k men an array-of-objects layout spends most of its time chasing pointers. Every
   pass over the army — steering, separation, integration, animation — is a linear scan, so
   SoA keeps each pass sequential in memory.
2. **The renderer uploads instance attributes with a single subarray copy per frame.** An
   AoS layout would need a gather pass to build every instanced buffer.

The layout, grouped as the file groups it:

- **Transform** — `x, y, z` (`Float32Array`), previous-tick `px, py, pz` for interpolation,
  `vx, vy, vz`, `facing`, `prevFacing`, `lean`.
- **Identity** — `unitId` (`Int32Array`), `faction` (`Uint8Array`), `slot` (`Uint16Array`),
  `rank`, `file` (`Uint8Array`, both saturated at 255 on spawn).
- **Condition** — `hp`, `maxHp`, `state` (`Uint8Array`, a `SoldierState`), `stateTime`,
  `target` (`Int32Array`, pool index of the current melee opponent or -1),
  `attackCooldown`, `fatigue`, `ammo`.
- **Animation** — `animClip`, `animTime`, `animPrevClip`, `animPrevTime`, `animBlend`,
  `animRate`.
- **Appearance** — `scale`, `variant` (a stable 0..1 hash that picks skin tone, beard,
  emblem, kit variant), `grime`.
- **Ragdoll** — `deathDirX`, `deathDirZ`, `deathVariant`.

`BattleSystem` keeps several more arrays of its own, sized the same way and indexed by the
same pool index: `elevated`, `support`, `slotX`, `slotZ`, `slotFacing`, `mounted`,
`onElephant`, `press`, `sepUsed`, `rallyX/Z/On/Until` (`src/sim/BattleSystem.ts:510-535`).
So does `CombatSystem` (`swing`, `swingFired`, `impacted`, `approach`, `attackers`,
`matchedWith` — `src/sim/Combat.ts:346-360`). The pool is the shared spine, not the whole
state.

### How a unit maps onto the pool

A `UnitGroupState` (`src/sim/types.ts:354`) is a plain object holding `members: number[]` —
an explicit list of pool indices, not a range. In practice `spawnUnit` allocates
contiguously, so a unit *is* a contiguous run, but nothing in the code depends on that and
`members` is always what is iterated.

`spawnUnit` (`src/sim/BattleSystem.ts:767`):

```ts
const scale = def.unitClass === 'artillery' ? 1 : this.unitSizeScale;
const strength = Math.max(1, Math.round(def.strength * scale));
...
const rng = this.rng.fork(`unit${u.id}`);
for (let s = 0; s < strength; s++) {
  const i = this.pool.alloc();
  if (i < 0) break;                       // pool exhausted; the unit is simply short
  u.members.push(i);
  ...
}
u.alive = u.members.length;
u.initialStrength = u.members.length;     // rewritten to what was actually spawned
```

Every stochastic per-man value — start-of-animation phase, attack cooldown offset, height
scale, `variant`, `grime`, `deathVariant`, animation rate — is drawn from a stream forked
per unit id, so a unit's men are identical for a given unit id whatever else happens
elsewhere in the battle.

Artillery is exempt from the unit-size multiplier because a scorpion needs two men per engine
whatever the player's battle-size setting says.

### Birth, death, and what `count` means

`alloc()` (`src/sim/types.ts:534`) is a bump allocator with no free list:

```ts
alloc(): number {
  if (this.count >= this.capacity) return -1;
  return this.count++;
}
```

**`count` is "slots ever allocated", not "men alive".** It only ever grows during a battle,
and it is the iteration bound for every pass: `for (let i = 0; i < pool.count; i++)`. Dead
soldiers keep their slot for ever, because their corpse still renders. Living-men counts come
from elsewhere: `u.alive` is recomputed per unit per tick in `updateUnitCohesion`
(`src/sim/BattleSystem.ts:1904`), and `BattleSystem.strength[faction]` is summed from those.

Death is a two-stage state machine, and both stages are still `count`-occupied:

- `damage()` (`src/sim/BattleSystem.ts:2704`) is **the single door a man can die through**.
  It subtracts hp, and on reaching zero sets `Dying`, records the death direction from the
  blow, throws the body at 1.4 m/s away from the attacker, clears `target`, credits the
  killer, registers an elephant carcass, and emits `soldierDied`.
- `updateAnimationState` flips `Dying` to `Dead` when the death clip's playhead reaches 1
  (`src/sim/BattleSystem.ts:2683`).

`isAlive` (`src/sim/types.ts:155`) treats both `Dying` and `Dead` as not-alive, so a dying
man is already out of the spatial hash and out of every combat query — he is a falling body,
not a combatant.

There is one other way a man leaves: when a routed unit gets clear of the field
(`routTimer > 18` s and either past ±1180 m or more than 260 m from the nearest enemy), the
unit is destroyed and every living member is set straight to `Dead`, skipping `Dying`
(`src/sim/BattleSystem.ts:1940-1946`). The comment records why: before this, one unit's
anchor was measured 770 m from its own men while 2,220 living men stayed in the spatial hash
and in every faction strength tally.

`DeploymentSystem.remove` does the same thing pre-battle, and notes explicitly that "the pool
slots are gone for good" — the *unit object* goes on a bench so its slots can be reused if a
unit of the same type is re-added (`src/sim/deployment.ts:663`).

### How big the pool actually is

`maxSoldiers` is the one quality setting the simulation reads, and it is deliberately kept in
its own interface (`SimQuality`, `src/core/Engine.ts:60`) so that the adaptive-quality loop's
patch type *cannot name it* — the mistake fails to typecheck rather than being caught in
review. It is frozen at construction (`src/core/Engine.ts:214`) and re-asserted after any
tier change. The comment records the bug that motivated this: `setQuality` used to replace
the whole settings object from the preset table, which changed `maxSoldiers` from 12,000 to
1,600 under a running sim.

Per tier (`QUALITY_PRESETS`, `src/core/Engine.ts:114-139`): low 1,600 · medium 3,200 · high 10,000 ·
ultra 12,000.

The actual order of battle is fitted to that ceiling by `fittedUnitScale`
(`src/sim/battleConfig.ts:606`), which is `min(requested, maxSoldiers * 0.94 / base)`.

I measured the shipped default battle by running `tools/qa-determinism.mjs` at this commit:
the pool reports **8,632** soldiers (Campus Martius, `field`, `unitSize: 'ultra'`,
`quality=high`). That figure decomposes exactly:

```
Rome     6x160 + 2x120 + 2x150 + 2x100 + 3x60 + 1x12(artillery, unscaled)  x2 = 3,772
Juthungi 6x180 + 3x170 + 3x110 + 2x100 + 2x80  + 3x50                      x2 = 4,860
                                                                       total  8,632
```

`PERF_VALIDATED_MEN = 9000` (`src/sim/battleConfig.ts:661`) is where the menu starts warning:
the pool bounds the battle at about 11,280 men but the frame budget gives out first, and the
comment carries the measurement — 8,644 men at 13.44 ms, 9,584 at 16.14 ms, 11,255 at
19.21 ms on the fixed-camera `rout` shot.

---

## 4. The spatial hash

`SpatialHash` (`src/sim/types.ts:618`) is a uniform grid with two-pass counting-sort
bucketing. One instance exists, owned by `BattleSystem`:

```ts
// src/sim/BattleSystem.ts:527
this.hash = new SpatialHash(1500, 2.0);   // halfExtent 1500 m, 2.0 m cells
```

It is rebuilt from scratch at the top of every fixed step
(`src/sim/BattleSystem.ts:1058`) — a full rebuild of 10k entries is cheaper than incremental
maintenance and, unlike incremental maintenance, cannot drift.

**Cell size is 2.0 m and that is a measured choice.** The separation pass asks for everything
within 0.84 m once per man per tick; at the previous 3.5 m cells that scanned about 37
candidates to find 6 (`src/sim/BattleSystem.ts:524`). The finer grid is affordable only
because the rebuild touches just the rectangle the armies stand on.

### The occupied-rectangle rebuild

The grid is 1502 x 1502 cells. Clearing and prefix-summing all 2.26 million of them every
tick would cost several times what bucketing 8,000 men does. So `rebuild`
(`src/sim/types.ts:673`) tracks the bounding rectangle of occupied cells and only clears,
prefix-sums and queries inside it. Outside the rectangle every counter is already zero, so
the result is **bit-identical to a whole-grid rebuild** — every excluded cell contributes
zero to the prefix sum, so the offsets, the `items` array and the order `query` walks it in
are all exactly what they were. Empty is represented as an inverted rectangle (`hi < lo`),
which makes every query a no-op rather than a read of stale offsets.

There is one spare column on the right (`cols = ceil(2*halfExtent / cellSize) + 2`) purely
so that `rebuild`'s write of each row's end offset at `cxHi + 1` has somewhere to land;
`cellOf` rejects it, so the accepted region is unchanged.

Dead and dying men are skipped at bucket time (`pool.aliveAt(i)`), so they are simply not in
the index.

### It is 2D and it never reads `y`

This is the single most consequential fact about the hash, and on a wall it is not a detail.

`cellOf` buckets on `(x, z)`. There is no third axis and there never has been. That was
harmless while every man stood on the terrain and became catastrophic the moment one stood on
a wall-walk, because **a defender 7 m up and an attacker at the foot of the masonry are
neighbours in the grid**. Measured before the fix: garrison and besiegers shoved each other
apart through three and a half metres of brick, and the front rank of both fought a melee
through the wall (`src/sim/BattleSystem.ts:307-318`).

Rebuilding the hash in three dimensions would cost every query on the field to fix a case
that affects a few hundred men. So the gate is applied **in the visitors instead** — one `y`
read per candidate, in loops that already read four other arrays:

```ts
// src/sim/BattleSystem.ts:321
export const SAME_LEVEL_DY = 1.9;
```

1.9 m is a little over a man's height: two men on the same walkway differ by centimetres, and
a walkway is never within 1.9 m of the ground beneath it.

Every consumer applies it, and if you add a new one you must too. The current set:

| site | file:line |
|---|---|
| melee acquisition (`acquireVisit`) | `src/sim/Combat.ts:208` |
| nearest-enemy probe (`nearestEnemyVisit`) | `src/sim/Combat.ts:239` |
| cavalry trample (`trampleVisit`) | `src/sim/Combat.ts:267` |
| keeping an opponent (the `keepR` test) | `src/sim/Combat.ts:761` |
| crowd separation | `src/sim/BattleSystem.ts:2176` |
| elephant carcass parting | `src/sim/BattleSystem.ts:2357` area |

The projectile visitors solve the same problem differently and more precisely: they test the
shaft's interpolated height against the candidate's foot height and a `HIT_TOP` band
(`src/sim/Projectiles.ts:529`, `:579`), which is a genuine 3D test rather than a same-level
gate.

### `query` and `nearest`

```ts
query(x, z, radius, fn: (index: number, d2: number) => void): void
nearest(x, z, radius, px, pz, accept): number
```

`query` walks the cells overlapping the circle, clamped to the occupied rectangle, and calls
`fn` for every indexed soldier in them. It does **not** filter by distance — the callback
must do its own precise filtering, and every one of them does.

Note the callback signature: the doc comment promises "the candidate index and squared
distance", and the implementation passes `r2`, the squared *radius*, identical for every
candidate (`src/sim/types.ts:747`). See [Known defects](#known-defects-and-gaps); it is
currently inert, because all nine call sites ignore the second argument.

Callers hoist their visitor callbacks to module scope with module-scope scratch variables
(`ACQ_X`, `SEG_X0`, `LOS_*`, ...) rather than closing over locals. That looks strange and it
is deliberate: a closure per man per tick would be thousands of allocations a second
(`src/sim/Combat.ts:165`).

---

## 5. Determinism

The contract: **the same config and the same seed replay identically.** Not "the same
battle looks similar" — bit-identical soldier positions.

### The generator

`src/util/rand.ts`. `Rng` is Mulberry32: one `uint32` of state, `next()` in five integer
operations. Seeds may be numbers or strings (FNV-1a hashed). Beyond `next()` it offers
`range`, `int`, `jitter`, `bool`, `normal` (Irwin-Hall n=4), `pick`, `pickWeighted`,
`shuffle` (Fisher-Yates), `inDisc`, and `getState`/`setState` for snapshot and restore.

```ts
// src/util/rand.ts:97
fork(salt: number | string = 0): Rng {
  const s = typeof salt === 'string' ? Rng.hashString(salt) : salt;
  return new Rng((this.s ^ Math.imul(s + 1, 0x9e3779b9)) >>> 0);
}
```

`fork` derives a child stream from the parent's **current state** and — critically — **does
not advance the parent**. Two consequences you have to hold in your head at once:

1. **Fork once, hold for ever.** Forking every tick hands back the identical stream every
   time. Every fork site in the sim is in `init` or in `spawnUnit`, and `CombatSystem`
   spells the reason out at `src/sim/Combat.ts:414`.
2. **A fork is not salt-only isolation.** Because it reads the parent's current state, a
   child stream depends on how many draws the parent has already made when the fork is taken.
   Given a fixed boot order that is reproducible, but reordering spawns would move it.

The live forks:

| stream | site |
|---|---|
| root, `new Rng('battle-271')` | `src/sim/BattleSystem.ts:434` |
| `fork('unit' + id)`, per unit at spawn | `src/sim/BattleSystem.ts:809` |
| `fork('combat')` | `src/sim/Combat.ts:416` |
| `fork('projectiles')`, `fork('artillery')` | `src/sim/Projectiles.ts:1032-1033` |
| `fork('siege')` | `src/sim/Siege.ts:1147` |
| `fork('ai-tactical')` | `src/ai/TacticalAI.ts:906` |
| `fork('ai-general')` | `src/ai/GeneralAI.ts:284` |

There is also a module-global `world = new Rng('SPQR-271AD')` (`src/util/rand.ts:132`), used
by world generation, not by the battle.

`hash01(index, salt)` and `hash2(x, y, salt)` are stateless per-index hashes for "random but
fixed" values you want the same every frame without storing them. The architecture rule
permits them in `update`/`preRender` for visual jitter; the sim uses `hash01` too, for things
that must be stable *and* agreed on by two parties without either seeing the other's roll —
matched-combat pairing is the good example (`src/sim/Combat.ts:830` onward).

### Seeding, and where it has to happen

```ts
// src/main.ts:172
battle.rng.setState(config.seed === 0 ? 0x9e3779b9 : config.seed >>> 0);
```

This runs **before `initAll()`** and mutates the existing `Rng` in place. Both are necessary
and both are non-obvious. Before `initAll` because `GeneralAI`, `TacticalAI` and
`Projectiles` all fork during their own `init`, and a fork taken from a stream that is
re-seeded afterwards is a fork of the *old* stream — the menu's seed field would silently do
almost nothing. In place rather than by replacement because anything that later captures
`battle.rng` would otherwise hold the discarded instance.

The default seed is `4265438264` (`src/sim/battleConfig.ts:513`), which is
`Rng.hashString('battle-271')` — the seed the battle used before it was configurable, pinned
to the literal so that every figure measured in `docs/` stays valid.

The menu's reroll button uses `Math.random()` (`src/ui/MainMenu.ts:465`). That is fine and
the comment says why: menu time only, and the seed it produces is then fixed for the whole
battle, which is what determinism actually requires.

### The rule, and how far it is actually enforced

`docs/ARCHITECTURE.md:74`:

> **Determinism rule.** Anything in `fixedUpdate` must be deterministic: no `Math.random()`,
> no `Date.now()`, no reads of frame time. Use `Rng` from `src/util/rand.ts`
> (`rng.fork('my-system')`). Visual-only jitter in `update`/`preRender` may use
> `hash01(index, salt)`.

**There is no automated enforcement of this rule anywhere in the repository.** No ESLint
config exists (and `eslint` is not a dependency); there is no `.github`, no CI, no
grep-based checker in `tools/`, and no npm script that looks for banned calls.
`tools/typecheck.mjs` only classifies `tsc --noEmit` output. The rule is held up by review
and by the hash gates below.

The codebase does comply, in the sense that matters:

- **`Math.random()` — no violations.** Two call sites exist in `src/`, both outside the sim:
  the menu's seed reroll (`src/ui/MainMenu.ts:465`) and the standalone model viewer's
  appearance reroll (`src/viewer/main.ts:720`).
- **`Date.now()` — no violations in browser sim code.** One reference, a
  `performance.now()` fallback in the audio bank builder (`src/audio/Synth.ts:2186`).
- **"No reads of frame time" is technically breached, benignly, in five places.** Five
  `fixedUpdate` bodies bracket themselves with `performance.now()` to populate a
  `lastCostMs` self-profiling field: `Combat.ts:512/531`, `Morale.ts:315/363`,
  `Projectiles.ts:1098/1118`, `Abilities.ts:121/176`, `Ragdoll.ts:332/336`. In each case the
  value is written only to `lastCostMs` and is never read back into a simulation decision.
  `src/ai/profile.ts` carries the same pattern behind an `AIProfile.enabled` flag that is
  false unless the F3 debug overlay is on, and its header states the constraint explicitly.

There is one further honest exception worth knowing about. **`RagdollSystem.fixedUpdate`
reads the camera position** to choose which `SIM_MAX = 40` deaths get the real verlet solve
(`src/sim/Ragdoll.ts:268`). The camera is a player input and is not part of the simulation
state, so this is a non-deterministic input inside a fixed step. It is safe because the
system is *write-isolated*: it reads `SoldierPool` and writes nothing back to it (I checked —
there is no assignment to any `pool.*[i]` in the file), publishing corpse poses through
`getCorpsePose`/`getCorpseJoints` instead. The real invariant is therefore narrower and more
useful than the written rule: **a `fixedUpdate` may read whatever it likes, as long as
nothing non-deterministic reaches state the simulation reads back.**

### How determinism is tested

Two gates, and neither lives in `src/`. The state hash is defined only inside the tools and
injected into the page with `page.evaluate`. What `src/` exposes is a raw handle:

```ts
// src/main.ts:308
window.__game = { engine, battle, ready, advance, setCamera, simTime, deployment };
```

#### `tools/qa-determinism.mjs`

Two independent page loads in one Chromium instance, advanced by an identical schedule, must
produce a bit-identical pool.

- Serves the app itself if nothing is listening (`npx vite --port 5226 --strictPort`),
  loads `?harness=1&quality=high&w=960&h=540`.
- **Calls `engine.stop()` first.** Without it, wall-clock time between Playwright round trips
  advances one run further than the other and every hash diverges for an uninteresting
  reason.
- Then drives `engine.advance(delta, 1000/60)` to each checkpoint. Default checkpoints are
  `0, 30, 90, 150, 200` sim seconds (`--at=`).
- The hash is **32-bit FNV-1a over the exact float bit patterns** — `dv.setFloat32` then
  `dv.getUint32`, deliberately avoiding any `toFixed()` smoothing, so a 1-ULP drift is caught
  rather than rounded away. Four fields per soldier, over `0..pool.count`: **`x`, `z`,
  `state`, `hp`**. It also returns `count` and `alive`.
- A checkpoint fails if `hash`, `count` or `alive` differ. Exit code is `failed ? 1 : 0`.

I ran it against this commit (`--at=0,10,30`, on a port of my own):

```
  t+  0  A 0fa6e702 (8632/8632)   B 0fa6e702 (8632/8632)   IDENTICAL
  t+ 10  A 531d18de (8632/8632)   B 531d18de (8632/8632)   IDENTICAL
  t+ 30  A c6ef8d38 (8632/8632)   B c6ef8d38 (8632/8632)   IDENTICAL
  determinism verified across 3 checkpoints at 8632 soldiers
```

#### `tools/qa-deploy.mjs`, arm 4 (`--only=det`)

The same idea asked of a **hand-deployed** battle rather than a scripted one: two loads
driven through the same deployment by the same synthetic mouse events, then advanced 60 s
and hashed at `0, 30, 90`. It reports two separate results, and the split is the point:

- **`deployment-reproduced`** — did the *harness* place the unit identically? Compared on
  `{x, z, facing, width, formationId}`, pre-quantised by `window.__unit` to 2 decimal places
  on position and 4 on facing.
- **`deployed-battle-replays`** — did the *simulation* then reproduce the outcome? Compared
  on `hash`, `count` and `sim` (`simTime` to 3 dp).

"The harness did not reproduce the input" and "the sim did not reproduce the outcome" are
different findings and only the second is a bug. Two measured details recorded in that arm
are worth borrowing if you write a similar test: it uses a right-*click* rather than a
right-*drag*, because a drag's resulting frontage depends on how many `pointermove` events
the browser coalesces and two runs placed the same unit at widths one apart; and it calls
`engine.stop()` *before* clicking BEGIN rather than after, because otherwise run A reached
sim 0.233 s and run B 0.200 s before either had been advanced at all.

Also worth knowing: **the hash function is copy-pasted between the two files**
(`qa-determinism.mjs:67` and `qa-deploy.mjs:1010`), with no shared module, and both hardcode
the literals `10` and `11` for `Dying`/`Dead` rather than importing `SoldierState`.

### What a hash divergence actually tells you

Less than you would hope, and the gap is worth stating plainly.

**What you get** (from `qa-determinism.mjs` only; the `qa-deploy` arm has no localisation at
all): the first diverging *checkpoint*; up to 12 differing soldier pool indices with their
unit ids; which of the four hashed fields differ and both values; and the blast radius as a
count and a percentage of the pool.

**What you do not get:**

- **The first diverging tick.** Resolution is the checkpoint list. With the default `--at`, a
  divergence "at t+30" happened somewhere inside 900 ticks. Bisecting means re-running with
  a denser `--at`.
- **A snapshot at the diverging checkpoint.** `run()` advances each page through *every*
  checkpoint before returning, so both pages are parked at the **last** checkpoint when
  `__poolDump()` is finally called — but the output is labelled with the *first* diverging
  checkpoint. Unless the first divergence is also the last checkpoint, the soldier indices
  and values printed are the end state under the wrong heading, and the percentage is the
  cascaded blast radius rather than the first-touch footprint.
- **Anything outside the four hashed fields.** `y`, `facing`, velocities, `target`,
  `fatigue`, `ammo`, `stateTime`, rank/file, all unit-level state, all projectile state, all
  siege state, and the RNG stream positions are **not hashed**. A divergence in any of them
  is invisible until it propagates into `x`, `z`, `state` or `hp`. That is usually quick, but
  it means the gate localises in *space* and not in *cause*.
- **Any attribution at all.** No system name, no tick, no call site, no stream identity.

So the honest reading of a red gate is: *something* introduced an ordering or a
floating-point difference somewhere before this checkpoint, and here are some men it reached.
The next step is always a manual bisect on `--at`, then a bisect on subsystems.

**And the equivalence the design is built around is not itself tested.** `Engine.advance` and
`Time.rebase` both carry comments saying that N short advances being equivalent to one long
advance is "exactly what determinism tests compare". No tool in the repository executes a
one-long-advance arm against an N-short-advance arm. Both arms of `qa-determinism.mjs` use
the *same* schedule, which tests reproducibility but not equivalence. I verified the property
by hand against the real `Time` class (the table in §2) and it holds — but nothing in CI
would notice if it stopped holding.

---

## 6. Combat

`CombatSystem` (`src/sim/Combat.ts`, order 20) resolves melee. Its `fixedUpdate` is four
passes: `rebuildAttackerCounts`, `surveyUnits`, `fightUnits`, `resolvePush`.

### Acquisition

A man looks for the nearest living enemy inside his weapon's reach, biased hard toward
whatever is in front of him, and holds that opponent until it dies or slips out of reach.
Three things shape it:

**The scoring.** `acquireVisit` (`src/sim/Combat.ts:202`) rejects self, same faction, dead or
dying, anyone more than `SAME_LEVEL_DY` away vertically, and anything outside the radius,
then scores `-distance + facingDot * FRONT_BIAS` where `FRONT_BIAS = 1.6` m. The faction test
is `p.faction[j] === ACQ_OWN_FACTION` — *reject my own side* rather than *match the one enemy
side*. That inversion is not stylistic: with three factions on the roster, the old
`u.faction === 0 ? 1 : 0` form gave a Roman unit enemy id `1`, so a Roman standing against a
Carthaginian never acquired him — no target, no blows, no damage, and no error anywhere. Two
of the three possible matchups did literally nothing.

**Striping.** The hash probe is the most expensive thing in the loop, so acquisition is
spread across ticks (`src/sim/Combat.ts:770`):

```ts
const eager = p.rank[i] <= 2 || loose || cav || s.contactSeconds > 4;
const due = eager ? ((i + phase) & 7) === 0 : ((i + this.tick) & 31) === 0;
```

Front ranks, loose orders and cavalry look every 8 ticks (0.27 s); deep ranks every 32
(1.07 s), because they almost never have anything in reach.

**Crowding.** `attackers[]` counts how many men are on each soldier, rebuilt as a full O(n)
pass each tick rather than incremented and decremented on retarget — cheaper, more robust,
and self-healing after a rout. `CROWD_SOFT_CAP = 2` makes a crowded target progressively
less attractive; `CROWD_HARD_CAP = 4` makes him unreachable. Without a hard cap, two 160-man
blocks pressed into each other interleave along the seam until 63% of both units are
swinging, which triples the kill rate and turns a two-minute grind into a twenty-second
massacre.

### Reach, `ACQUIRE_PAD` and `keepR`

```ts
// src/sim/Combat.ts:700
const acquireR = def.reach + ACQUIRE_PAD;   // ACQUIRE_PAD = 0.86
const keepR    = def.reach + KEEP_PAD;      // KEEP_PAD = ACQUIRE_PAD + 0.32 = 1.18
```

Two radii: the distance at which a man will *take* an opponent, and the (larger) distance at
which he will *drop* one he already has. The interesting part is that these are written as
one pad plus a band, rather than as two independent constants — because two independent
constants is exactly how they drifted apart. The previous values were `reach + 0.25` and
`reach + 0.9`: a 0.65 m band, which is 60% of a gladius's entire reach, and a man would hold
an opponent at 2.0 m that he could never have taken at 1.35.

`ACQUIRE_PAD = 0.86` is one body diameter (`2 x SOLDIER_RADIUS` = 0.84) plus a centimetre —
the geometric statement of "his own body brings the man behind him that much closer". The
cost of getting it wrong was measured with `tools/probe-meleegeom.mjs`: two settled 160-man
blocks put rank 0 at 0.69 m, rank 1 at 1.23 m and rank 2 at 1.69 m, so the old 1.35 m radius
covered all of rank 0, 52% of rank 1 and *none* of rank 2. The consequence was that for sword
units, geometry — not `ENGAGE_PER_WIDTH` — decided how many men fought: spears reached 49.9
of a cap of 50, swords 19.5-20.4 of a cap of 35. A spear at reach 2.4 was unaffected either
way.

`KEEP_PAD`'s 0.32 m band is four ticks of `MAX_SEPARATION_FIGHTING` (0.08 m), the largest
jostle crowd separation can inflict on a man in melee. Anything narrower and a man drops the
opponent he is mid-stroke against because somebody leaned on him — and re-finding him costs
up to a quarter of a second of striping.

The `keepR` test also drops an opponent who is no longer on the same surface
(`src/sim/Combat.ts:761`): a man pushed off a boarding ramp is not still in melee.

### How many men can fight

Frontage decides a Total War melee, and this is where that is implemented:

```ts
// src/sim/Combat.ts:712
const engageCap = Math.max(6, Math.round(
  Math.min(u.width, u.alive) * (def.reach >= 2.2 ? 1.8 : 1.2)));
```

`ENGAGE_PER_WIDTH = 1.2` men per metre of frontage, `1.8` for spears — because a spear
reaches past the man in front, which is the entire point of a spear. A measured Rome II
engagement puts about 35 of a 160-man unit in contact. Men behind the fighting line close up
into it (`BattleSystem`'s press, bounded at `PRESS_RANKS = 2.5` ranks) so the hole a dead
front-ranker leaves is filled rather than ending the fight.

### Resolving a blow

`resolveBlow` (`src/sim/Combat.ts:1048`). Timing is animation-driven: a swing starts when the
cooldown expires and the blow lands at the attack clip's `hitFrame` through it (default 0.45
if no animation system is registered).

Two different facings are used, and the split is the model's cleverest bit:

- **Shield cover** comes from the *man's own* facing — he can turn to meet a blow.
  `shieldCoverage` (`src/sim/combatShared.ts:50`) smoothsteps between 50 degrees (fully
  behind the boss) and 100 degrees (edge-on and useless).
- **Flank and rear** come from the *unit's* facing — a man can turn, but his cohort is still
  being rolled up from the side. `aspectOf` (`src/sim/combatShared.ts:65`) gives
  Front / Flank / Rear, feeding `ASPECT_DAMAGE = [1, 1.22, 1.45]`,
  `ASPECT_ARMOUR_BYPASS = [0, 0.12, 0.28]` and `ASPECT_DEFENCE = [1, 0.82, 0.6]`.

Hit chance is `clamp(0.5 + 0.5*(atk - dfn)/(atk + dfn), 0.15, 0.75)`. The floor and ceiling
are Rome II's documented values and the *floor* dominates every lopsided or heavily-armoured
matchup; this project shipped 0.07-0.93 first, which let a favourable matchup land nine blows
in ten.

Armour is a diminishing curve, not a subtraction:
`armourReduction(a) = a / (a + 55)`, scaled by `ARMOUR_BITE = 0.85`
(`src/sim/combatShared.ts:33-40`). A flat subtraction at these numbers is degenerate —
legionary armour of 58 against a warband's 27 damage means a tribesman literally cannot kill
a legionary except through his 5 points of AP, and the melee deadlocks.

Anti-cavalry damage is mostly AP (`0.4` conventional, `0.6` armour-piercing,
`src/sim/Combat.ts:1136`) because a spear stopping a horse is a penetrating wound. Without
that split, mail beats ash and the whole spear-versus-horse relationship inverts.

`MATCHED_COMBAT_SHARE = 0.25` of mutual pairings become choreographed duels — the pair stops
dead, faces each other exactly, is exempt from being shoved by the push, and has its two
swing clocks phased half an interval apart. Whether a given pair duels is decided from the
pair's own stable hash, so both men reach the same answer without either seeing the other's
roll.

### The push

`resolvePush` (`src/sim/Combat.ts:1301`) displaces the losing formation along the **contact normal averaged over every
man who has an opponent** — not along the bearing to the enemy's anchor. Those are different
directions once two blocks have met off-centre, and using the anchor bearing made a pair of
units rotate about each other instead of one giving ground (`src/sim/Combat.ts:369`).

The contact *lock* is owned by `BattleSystem`, not here: `u.contactLock` is set from
front-rank-to-front-rank geometry at `CONTACT_ENTER = 1.6` m and released at
`CONTACT_EXIT = 4.5` m, holding anchors `CONTACT_GAP = 1.0` m apart
(`src/sim/BattleSystem.ts:192-196`). While locked, movement may not translate the anchor —
only `Combat.resolvePush` may move it — because otherwise the anchor keeps walking into the
enemy, the two blocks interpenetrate, and each ends up chasing a point inside the other.

`ENGAGE_REACH = 5.0` m (`src/sim/BattleSystem.ts:214`), the distance inside which a formation closes the last stride into
contact on its own, is deliberately **larger** than `CONTACT_EXIT`. Setting it below the
release distance looks like sensible hysteresis and recreates the bug it exists to kill: the
loser of a shoving match gives ground until the fronts are 4.5 m apart, the lock drops,
`resolvePush` stops — and if closing cannot reach that far, both units stand there under
long-satisfied orders and a fight simply stops, mid-fight, for ever.

### Crowd separation

`resolveCrowding` (`src/sim/BattleSystem.ts:2145`) is a single Gauss-Seidel pass at
`radius = 0.42` m, split by inverse mass. A man in melee counts as *heavier* (mass term 3, vs
1 loose and 5 mounted) because a man in melee is set: feet planted, shoulder behind the
shield. Without it, the front rank of a formation jammed into a gate is shoved sideways by
the whole weight of the column behind it — measured in the Porta Flaminia carriageway at
0.202 m of purely lateral movement per fighting man per second.

Displacement is budgeted per man per tick: `MAX_SEPARATION_STEP = 0.22` m (6.6 m/s) for a
loose body, `MAX_SEPARATION_FIGHTING = 0.08` m (2.4 m/s) for a man in melee. Separation is a
positional fix-up rather than a force, so its magnitude is the *sum* of a man's overlaps and
has no natural ceiling: on a 3.45 m wall-walk with a lodgement arriving over a boarding ramp,
58 cm of purely lateral movement was measured in a single 33 ms tick, which is 17 m/s and
reads as a man being flung along the parapet. Both sides of the Gauss-Seidel write are
budgeted, which bounds the correction without changing iteration order — so the result stays
deterministic.

### Missiles

`ProjectileSystem` (`src/sim/Projectiles.ts`, order 25) integrates real trajectories with
gravity and quadratic drag out of pooled typed arrays — never an object per arrow. Launch is
solved for the target's predicted position; the launch solve is drag-free and each weapon
carries a `dragComp` fraction to aim past the target. `arc: 'high'` (bows, slings) lofts at a
fixed elevation and varies draw weight; `arc: 'flat'` (pila, javelins, bolts) takes the low
ballistic root at full power. Misses bury themselves where they land.

Per unit it runs one of two state machines: `updateBattery` for engine units and
`updateVolley` for men. Running both over a battery is what put twelve bolts in the air for
four engines.

#### Friendly fire, and `FRIENDLY_ARM`

**A shaft does not know whose men are on its line, and that is on purpose.** Firing into your
own back is a tactical mistake the player has to be able to make, so nothing makes a missile
pass through a friendly. Four separate mechanisms instead keep it rare:

1. **`FRIENDLY_ARM = 1.3` m** (`src/sim/Projectiles.ts:420`) — a shot is inert *to its own
   side only* for the first 1.3 m from the muzzle. Applied in `segmentVisit` as a 3D distance
   from the release point, and only while the shaft is still inside that bubble, so the
   faction read costs nothing on the overwhelming majority of candidates.
2. **Lane check before release** — a man will not loose while one of his own stands in the
   swept lane in front of him, out to `LANE_M = 5.0` m (his own block and no further). It is
   a *swept segment*, not a row of point samples: the old form stepped at 1.5 m over ranks
   0.86 m apart, so a man could stand in two thirds of the lane and never be looked at.
3. **At-will target refusal** — a unit shooting at will will not shoot *over its own line*
   into a block that is already locked in melee.
4. **No credit** — a friendly kill passes `attackerUnitId = -1`, so nobody is credited, no
   `killPulse` is paid and no wall kill is noted.

The reason `FRIENDLY_ARM` is a **distance** and not the **time** it used to be is worth
keeping. `ARM_TIME` was 0.06 s, which is 4.7 m for a ballista bolt and 0.20 m for the same
bolt after `aimOverParapet` re-draws it to 6 m/s to clear a merlon at ten paces — one
constant meaning two entirely different distances, and for the slow half of them the shot
went live *inside the file it was loosed from*. Measured on Carthage's parapet, 89% of every
friendly casualty happened within 0.9 m of the muzzle, at 0.067 s, on a man in the shooter's
own rank: the man standing next to him.

1.3 m is arithmetic: 0.86 m is a file's lateral spacing, 0.72 m a rank on a wall-walk,
`HIT_RADIUS` is 0.4. So 1.3 m is the far side of the eight men physically touching the
shooter and nothing else — the next man out stands at 1.72 m with his near surface at 1.32.
It is the statement of something a release point cannot express: a real archer's bow arm is
outside his own rank and his own file by construction.

Past 1.3 m a shaft hits whoever is on its line. Deliberately not a blanket faction test,
because a volley that cannot hit your own men is not a volley you have to think about where
to stand.

Both halves of the at-will refusal are load-bearing. With the corridor test dropped, one
battle's archers went from 84 enemy killed in a 30 s slice to 15 — sixty-nine enemy lives to
save three of our own — because once a line is locked, half its length is still open to
enfilade from the wing. Together they are the mechanic the whole thing is for: move the
archers off the back of your own line and onto its flank and they shoot again. An *ordered*
volley still goes in, because deciding to shoot into a melee and wear the losses is a real
order.

Aggregate effect, measured on Carthage's parapet: 63.9% of hits landing on our own men, at
19.6 friendly kills a minute against 21.1 enemy, down to 19.3% and 3.8 against 42.1.

`BattleSystem.damage` carries a backstop: a killer of the same faction as the victim is
refused the credit and the refusal counted in `creditRefused`. Melee cannot currently reach
that branch — `acquireVisit` and `trampleVisit` are the only two things that hand `Combat` a
victim and both reject same-faction candidates before scoring, measured over 2,781 lethal
blows across three battles with not one same-faction credit. It is a fence for the next
person who adds a way of hitting a man, not a fix.

---

## 7. Morale

`MoraleSystem` (`src/sim/Morale.ts`, order 30). One scalar per unit under competing pressure
and recovery. This is what actually decides battles: men are not killed to the last.

### The pressure terms

All in morale points per second before discipline (`discipline` divides all of it, so a
praetorian at 1.42 takes about a third less than a warband at 0.98). Coefficients at
`src/sim/Morale.ts:138-219`:

| term | constant | value |
|---|---|---|
| attrition | `P_ATTRITION`, `P_ATTRITION_EXP` | 22, cubic |
| men dying now | `P_CASUALTY` | 0.22 |
| flanked / surrounded | `P_FLANKED`, `P_SURROUNDED` | 8, 9 |
| local exchange (signed) | `P_EXCHANGE`, floor | 3.0, 0.6 |
| cavalry in your face | `P_CAVALRY` | 4.5 |
| exhaustion | `P_FATIGUE` | 0.45 |
| incoming missiles | `P_MISSILE`, cap | 0.14, 3.0 |
| army mood | `P_ARMY`, winning | 3.0, 0.4 |
| army broken share | `P_ARMY_BROKEN`, cap | 4.0, 2.2 |
| witnessing routs | `P_WITNESS_FRIEND/ENEMY`, cap | 1.5 / 2.2, 3.0 |
| being pursued | `P_PURSUED` | 2.2 |
| recovery, engaged / clear / rallying | `R_ENGAGED`/`R_CLEAR`/`R_RALLYING` | 0.9 / 2.4 / 3.4 |

Three structural rules matter more than any individual coefficient:

1. **The attrition curve is cubic and deliberately almost flat at the bottom** — 0.18 pts/s
   at 20% losses, 0.59 at 30%, 1.41 at 40%, 2.75 at 50%, 4.75 at 60%. Below about a third of
   the unit it does not even overcome the in-contact recovery, so pure attrition cannot break
   a formation early; past half it folds in seconds. The consequence is that *tactics* break
   units and grinding does not.
2. **The army-level term is computed from casualties, not from how many units are still in
   order.** The old form divided living men in unbroken units by deployed strength, so the
   instant one unit routed every unit's pressure rose — which made the next rout more likely,
   which raised it again. Measured: 8.5 pts/s of pure army-mood pressure on Juthungi units
   that had lost 3% of their men and were not in contact with anything.
3. **The net fall is hard-capped at `MAX_FALL_RATE = 5` pts/s.** Described in the file as
   "the single most important number", and it is: every term can be argued about, but they
   *summed* to twenty-odd points a second, taking a full-strength unit from steady to broken
   in three seconds and its neighbours with it. Rises are not capped — recovering nerve
   should feel immediate when a unit is pulled out.

On top of the cap, pressure is low-passed with `PRESSURE_TAU = 4.0` s, reproducing Total
War's `percent_update_per_tick` behaviour: units visibly waver before they go, rather than a
switch being thrown. One-shot shocks bypass the filter and hit `morale` directly, because a
shock is supposed to feel like a shock.

`FLANK_DEADBAND = 0.28`: a quarter to a third of blows always land at an angle in a real
press, and `aspectOf` reports those as flank hits. Without a deadband that noise was worth
over two morale points a second in a head-on fight, and it is what made a warband fighting
an urban cohort frontally break at 12% losses. Being *flanked* means most of the blows are
off the front, not a few of them.

`isSurrounded` requires `flankedFraction > 0.58 && rearFraction > 0.2` — derived from where
blows land, not from where enemy anchors sit, because once ranks interpenetrate anchor
geometry lies.

### Bands, rout and rally

| threshold | value |
|---|---|
| `WAVER_FRAC` | 0.50 of max morale |
| `BREAK_FRAC` | 0.12 |
| `RALLY_FRAC` | 0.34 |
| `RALLY_DELAY` | 12 s of running first |
| `RALLY_CLEAR` | 95 m from the nearest enemy |
| `MAX_RALLIES` | 1 |
| `SHAKEN_PENALTY` | 9 points of max morale, permanently, per break |
| `CONTAGION_RANGE` | 145 m |
| `CONTAGION_SHOCK` | 4 points, one-shot, scaled by distance |

`BREAK_FRAC` together with the attrition curve sets **how deep a unit fights before it runs**,
and that — not the damage curve — is what decides how long a battle lasts. The file's
reasoning is worth reproducing because it is a real finding: reconstructing Divide et
Impera's much-advertised damage, armour and health cuts shows they very nearly cancel
(hits-to-kill 6.00 to 6.15); its 20-40 minute battles come from routing at 50-60% casualties
where vanilla routs at 15-20%. Creative Assembly reached the same conclusion the hard way
across Patches 3, 9 and 15.

`MAX_RALLIES = 1` with a permanent 9-point penalty per break is what stops a battle
oscillating for ever between rout and rally.

Contagion is spread by `spreadPanic`, subscribed to the `unitRouted` event. `CONTAGION_SHOCK`
was 11, which was most of the way to breaking a warband (62 morale, routs at 11) from three
neighbours going, and cascaded 1,500 men in about twelve seconds. A cascade is right; a
cascade inside one tick is not.

### Collapse

`MoraleSystem.checkResolution` computes "power" as living men in unbroken units weighted by
`clamp01(morale / (maxMorale * 0.5))`. A side is beaten if `power < DECISIVE_FRACTION` (0.2
of its deployed strength) **or** if it holds less than `DECISIVE_RATIO` (0.3) of the
opponent's power while also below `DECISIVE_RATIO_OWN` (0.45) of its own start. The condition
must hold for `DECISIVE_HOLD = 14` s. Both sides collapsing at once resets the timer — a
mutual failure is not a decision.

The verdict is **not announced here**. `MoraleSystem` sets `battleOver` and exposes
`decided`; `BattleFlowSystem` is the single authority for the result, because it carries the
casualty tallies, handles the timeout case and sets the winners to cheer. Both systems reach
the same verdict within a few seconds of each other, so emitting from both fired
`battleEnded` twice and showed the results panel twice.

One structural note: `Morale` collapses three factions into **two sides** by
`faction === Faction.Rome ? 0 : 1` (`src/sim/Morale.ts:328`). That is correct for every
battle the game can currently produce — Rome is always on one side — and would need
revisiting the day two non-Roman armies meet.

---

## 8. `BattleFlow`

Two things share the name and they are unrelated. `src/ui/BattleFlow.ts` is a UI screen.
**`src/sim/BattleFlow.ts` is the system that decides when the engagement is over and who
won**, and that is what this section is about. Without it the simulation runs for ever.

### Phases

`BattleFlowSystem` has **no notion of a phase.** Phases are a UI-model concept, derived
fresh every refresh from the current state of the field, and there are two independent
ladders.

**Field-battle phases** — `Phase` (`src/ui/theme.ts:180`) is
`deployment | advance | skirmish | clash | rout | aftermath`, derived by
`HudModel.derivePhase` (`src/ui/model.ts:358`):

```ts
if (over) return 'aftermath';
if (routing[Rome]/rTotal > 0.34 || routing[foe]/gTotal > 0.34) return 'rout';
if (engagedCount > 0) return 'clash';
if (lineGap < 165) return 'skirmish';      // 165 m is the longest bow range in the roster
if (simTime < 6) return 'deployment';
return 'advance';
```

**Siege phases** — `SiegePhase` (`src/ui/siege.ts:37`) is
`approach | ram | wall | breach | streets`, derived by a second `derivePhase`
(`src/ui/siege.ts:176`) read off events at the wall rather than off the clock or the distance
between armies. The union is written in chronological order and the function tests it
*backwards*, returning the furthest thing that has happened. `wall` outranks `ram` because
men on the parapet is further on than the ram having struck, and a storm is usually doing
both.

`TopBar.sync` swaps to the siege ladder for everything except `deployment` and `aftermath`,
because the field readings are all wrong at a wall: at t+982 with the gate broken and two
towers docked, the plaque read "MISSILE EXCHANGE, arrows and pila in the air".

**Both functions are pure functions of the current field, so phases can and do go backwards.**
A `clash` becomes a `skirmish` again if every engagement ends; a `wall` reverts to `ram` if
the last man is knocked off the parapet; `rout` reverts to `clash` if broken units rally
below the 0.34 share. Nothing latches. `HudSystem` does force `deployment` while the
deployment phase is open, because otherwise a garrison already on the wall with missile
troops in range reports "Missile Exchange" over a battle that has not started.

### Victory in a field battle

Four ways a field battle ends. Constants at `src/sim/BattleFlow.ts:26-71`.

1. **Cohesion collapse** — a side is *spent* if it has no unbroken units at all, or if its
   men-still-in-order fall below `COLLAPSE_STRENGTH = 0.22` of what it deployed, or if the
   margin rule below applies. The condition must hold `CONFIRM_SECONDS = 6` s; the confirm
   timer counts down at *twice* the rate it counts up, so a momentary wobble mid-melee cannot
   end a battle. Reason is `annihilation` if the loser genuinely has no living men, otherwise
   `rout`.
2. **The margin** — `DECISIVE_RATIO = 0.33` and `DECISIVE_OWN = 0.5`: beaten below half of
   what you brought, *and* holding less than a third of what is still standing opposite you.
   Both halves are required. Measured motivation: a passive Rome on the Campus Martius is
   ground from 3,772 down to 1,141 by t+1200 while the Juthungi still have 3,951 in order,
   and `COLLAPSE_STRENGTH` cannot see it because 1,141 is thirty per cent of Rome's own
   establishment and the floor only compares a side against itself. Nothing then happened for
   another twelve hundred seconds — sixteen and a half real minutes of a frozen scoreboard.
3. **Stalemate** — `STALL_SECONDS = 120` s with no casualty anywhere on the field, counted
   only *after* the first casualty so that two armies who have not met yet are not a
   stalemate. Not a heuristic about intent: in a battle, men die. Winner is decided
   `onPoints`, which is a draw inside five per cent.
4. **Timeout** — `TIMEOUT_SECONDS = 2400` s. Raised from 1200 once break depth was fixed:
   units now fight to 33-52% casualties instead of 12-28%, and an even AI-vs-AI battle was
   still genuinely contested at t+500.

`sides` is built from **whoever actually deployed**, not from a `[Rome, Germanic]` literal.
That literal ended the storm of Carthage six seconds after it began: Carthage fields no
Juthungi, so the Germanic side snapshotted `initialMen: 0`, scored `frac = 0`, was judged
spent on the first tick and confirmed as the loser at `CONFIRM_SECONDS`, handing Rome an
instant victory over an army that was never there.

### Victory in a storm

**A storm is judged on ground, not on corpses.** A garrison that has lost half its men and
still holds the parapet has not lost; a besieger with a whole host in reserve who never gets
over the wall has not won. So `decisiveApplies` (`src/sim/BattleFlow.ts:406`) **switches the
margin rule off entirely for both the garrison and the storm.** A garrison is *meant* to be
outnumbered — Rome holds the Aurelian Wall with 1,154 against 1,920 — so applying the ratio
would call the city taken at the opening whistle. In a storm the wall decides and nothing
else may.

Whether this is a storm at all is read off the *field*, not out of the city plan: whoever the
siege system has standing on the stonework when the battle opens is the garrison
(`findWall`, `src/sim/BattleFlow.ts:438`). It uses `siege.isGarrisoned(u.id)` rather than
`u.order === UnitOrder.Garrison`, because the order is a mutable field any halt overwrites
and the tactical layer updates at order 42 — one slot ahead of this system.

A census runs **once per second**, not per tick (`censusDue`), because it walks every unit
and the whole pool and a wall does not change hands inside a second.

#### The besieger's two conditions

```ts
// src/sim/BattleFlow.ts:289
const taken = c.stormHolding >= WALL_FOOTHOLD;
this.parapetHeldFor = taken ? this.parapetHeldFor + dt : 0;
if (this.parapetHeldFor >= WALL_HOLD_SECONDS || c.stormInside >= BREAK_IN) {
  this.finish(ctx, this.wall.storm, 'objective');
}
```

**Condition A — take a stretch of wall and hold it.** Get `WALL_FOOTHOLD = 24` of your men
onto parapet the garrison has stopped contesting, and keep them there for
`WALL_HOLD_SECONDS = 20` s uncontested. Twenty-four men is about a third of a bay's standing
run at the sim's 0.72 m rank pitch — the smallest body that can hold a stretch of walkway
against a counter-attack up a stair. Twenty seconds is long enough that a garrison run which
is merely momentarily empty does not hand over the city.

**Condition B — get into the streets.** Put `BREAK_IN = 60` men more than
`INSIDE_MARGIN = 14` m past the curtain's own line, measured against each bay's outward
normal, and the wall stops mattering. Sixty is roughly one warband: a body a reserve cohort
cannot simply push back into the ditch.

Either one ends the battle immediately with `reason: 'objective'`.

#### `stormHolding` and the `contestedRuns` rule

This is the part that is easy to get wrong and was, twice.

`Siege` cuts the wall spine into **runs** — maximal stretches a man can walk without leaving
the wall. On the Aurelian Wall there are 45 of them for 45 garrisonable bays: 1,695 stations,
about 38 m and 38 stations apiece, so a run is a bay.

The census bins both sides by run, then finds **maximal blocks of consecutive runs the storm
has men on**. A block counts as *held* on two conditions:

- no man of the garrison stands anywhere on it, **and**
- at least one of its runs is in `contestedRuns`.

`stormHolding` is the sum of storm men over every block that passes. Condition A asks *that*
number to reach 24, not `stormOnWall`.

`contestedRuns` (`src/sim/BattleFlow.ts:204`) is a `Set<number>` of every run the garrison
has stood on **at any point in the battle**. A run enters the set the moment a defender is
counted on it and never leaves. It is cleared in `init`, because which bays were defended is
a fact about *this* battle and is the one piece of state here that would silently hand the
next battle a wall it had already taken.

Why it exists: Rome's 810 men do not cover the circuit. They stand in eight or nine blocks of
about a hundred, five ranks deep over twenty stations, and most of the 45 runs have nobody on
them from the first tick to the last. Without the set, condition A would be satisfied by
putting a ladder against a bay nobody was ever defending and standing on it for twenty
seconds — the wall "uncontested" because the fight is four hundred metres away. With it, the
ground the storm holds has to be ground the garrison held, and a garrison that marches to
meet a lodgement makes that bay count from then on whether it wins the fight there or loses
it.

The condition it replaced asked `garrisonOnWall` to reach zero. On the Aurelian Wall that is
810 men over 1.78 km, and across twelve seeded runs the smallest it ever reached was 542. The
bar was never approached, let alone met.

A **shoulder rule** — also requiring the run either side of the lodgement to be clear — was
tried and removed, and the measurement that killed it is instructive. On a three-bay
garrison the storm fought for bay 18 from t+251 with 25 men against 57, killed the last
defender by t+297, then stood on it with 55-84 men and nobody else for fifty seconds — while
65 defenders on bay 19 held exactly 65 men and took **not one casualty** from t+251 to t+347.
Rome's garrison holds the bay it is given; it does not counter-attack along the walkway. So
"a defender within one bay" is not a measurement of contest at all — it is a demand that the
storm also destroy a body of men who are not fighting it, which is annihilation again. A run
is its own margin: 38 m, with a two-dozen-man lodgement occupying about 17 m of it.

#### The garrison's condition

**Condition C — throw the assault back.** `STORM_STALL_SECONDS = 180` s during which the
assault fails to reduce the garrison's hold on the parapet, and the storm has lost
(`reason: 'repulsed'`).

It is a **low-water mark**, not a rate: `wallLowWater` records the fewest men the garrison
has ever had on the walkway, and any new low resets `noProgressFor` to zero. So any real
pressure — a run cleared, men dying on the walkway — resets it, and only a genuine plateau
runs it out.

Measured motivation: on the Aurelian Wall with a passive Rome, the garrison on the walkway
falls 606, 492, 474, 324, 193, **170, and then stops**. From t+450 to t+800 that number does
not move, Rome's strength does not move off 502, and the Juthungi lose about twenty men every
hundred seconds to the carroballistae — a grind that would take another two hours to reach
anybody's collapse floor. Nothing is *frozen*, so the no-casualty watchdog cannot see it;
what has stopped is progress against the objective.

Two guards on it: it only runs while `garrisonOnWall > 0` (with the garrison off the wall a
plateau at zero would run the timer out and hand the city to an army that is dead), and it is
suspended once `stormInside >= BREAK_IN`.

The timeout also favours the garrison in a storm: a besieger who has not taken the city by
nightfall has failed. Under the field rule, the Juthungi took the assault on a timeout with
1,917 men still outside a wall they never got over, against a garrison of 343 that had held
it all day.

#### The thresholds are published, not private

`BattleFlowSystem.objective` (`src/sim/BattleFlow.ts:606`) returns the census **and** every
threshold: `needInside`, `insideMargin`, `needFoothold`, `holdSeconds`, `stallSeconds`,
`stalledFor`, `heldFor`. The HUD reads them from there rather than re-declaring them, because
a second copy of the rules is a copy to drift from — and because the winning move (get sixty
men fourteen metres past the curtain) was otherwise undiscoverable. Measured: a hands-off
assault that put ~350 men on the parapet lost at t+286 with 41% casualties, while one cohort
through the broken gate won at t+336.

### What `finish` reports

`unitsLost` counts a unit as lost if it is destroyed, **or has broken, or is below a quarter
of its establishment**. Snapshotting only `destroyed` at the instant of victory reported "0
of 21 lost" on a battle whose roll of honour listed cohorts at 18 of 320 men and flagged them
ROUTED — units are marked destroyed later, as they leave the field, long after the result is
called.

---

## 9. The AI

Four subsystems sharing one blackboard (`src/ai/index.ts:15-18`):

```
pathfinding  40   nav grid, budgeted A*, flow fields   -- "can I get there"
tactical-ai  42   per-unit utility selector            -- "what do I do now"
general-ai   45   per-faction phase machine            -- "what is the plan"
ai-debug     46   F3 overlay, off by default
```

`main.ts` gives the AI every faction except the player's, unless `autoplay` is on, in which
case it takes all of them (`src/main.ts:217`). `PLAYER_FACTION` is Rome
(`src/ui/theme.ts:85`), so on the Rome assault the AI runs the Juthungi and on Carthage it
runs the Punic garrison against a human Rome.

### `TacticalAI`

`TacticalAISystem` (`src/ai/TacticalAI.ts:861`) is a `fixedUpdate` subsystem at order 42. It
runs every tick but *thinks* per unit on a throttle: `thinkInterval` ticks, staggered by
`unitId % thinkInterval` so the whole army does not deliberate on the same tick. At the
default `hard` difficulty that is 10 ticks — one decision per unit per third of a second
(`src/ai/types.ts:62`). Two edge-triggered conditions force an early re-think: entering or
leaving contact, and an enemy closing inside 55 m for the first time.

It reads the `AIWorld` blackboard (per-unit `UnitInfo`, per-faction fogged `FactionView`, and
the `UnitCommand` the general wrote last tick), the pathfinder, and a deliberately narrow
four-method view of the siege (`WallView`, `src/ai/WallDoctrine.ts:110` — the assignment at
`TacticalAI.ts:916` is the compile-time proof that `src/ai` never imports `src/sim/Siege.ts`).

**It is a utility selector, not a state machine.** Sixteen behaviours each score themselves
0-100 on the same scale; negative means never; the incumbent gets +6 hysteresis; the highest
wins. The behaviours are `hold-line`, `march`, `engage`, `brace`, `testudo`, `plug-gap`,
`refuse-flank`, `shoot`, `missile-withdraw`, `skirmish`, `cavalry-hold`, `cavalry-screen`,
`cavalry`, `pursue`, `inspire`, `parapet` (`src/ai/TacticalAI.ts:851`). Two small state
machines hang off individual behaviours: a cavalry cycle
(`hunt/swing/charge/stuck/withdraw/reform`) and a skirmish cycle
(`advance/loose/withdraw`).

**Its only output is `orderIssued` — the same event the player's mouse produces**
(`src/ai/Orders.ts:7`). `OrderBook` can emit exactly six kinds: `move`, `attack`, `halt`,
`facing`, `formation`, `ability`. Re-issue is de-duplicated by `MOVE_EPS = 4.0` m,
`FACING_EPS = 0.45` rad and `MIN_REISSUE_TICKS = 6`.

### What `TacticalAI` conspicuously does not decide

**It cannot order a storm, and on Rome that leaves the Germanic host standing in the field.**

This is a real, deliberate gap, and it has three independent locks — any one of which would
be sufficient on its own:

1. **The only wall behaviour is gated on already being on the wall.** `Parapet.applies` is
   `c.self.holdsWall(c.u.id)` (`src/ai/TacticalAI.ts:846`), which is
   `wall.isGarrisoned(unitId)`. A warband in the field is not in the siege's garrison
   register, so `Parapet` never applies to it. And `decideWall` has only two outcomes,
   `descend` and `traverse`, both of which presuppose you are already up there. **There is no
   "get on the wall" behaviour at all.**
2. **`pickMeleeTarget` refuses to target anyone the stonework holds**, unless we hold
   stonework too (`skipWall`, `src/ai/TacticalAI.ts:1448`). Since `Engage.score` returns -1
   when there is no target, a warband looking at a parapet full of ballistarii has no melee
   bid. This filter *is* documented — but as a fix for an ascend/descend yo-yo (a warband
   walked down into Rome and climbed straight back up the stairs), not as "the host never
   storms".
3. **The general has no siege roles.** `AIRole` (`src/ai/types.ts:80`) is
   `artillery | flank | screen | missile | reserve | shock | anchor | line`. There is no
   storm, escalade or breach member, so `tower-assault`, `escalade-party` and `ram-crew` are
   all classed as ordinary line units and dressed into the battle line beside the warbands —
   the general does not know they own machines.

There is **no `canStorm` predicate, no unit tag, and no hard-coded exclusion list**; the gap
is structural. There is also no `TODO` or `FIXME` anywhere in `src/ai` or `src/sim/Siege.ts`
acknowledging the consequence.

**On the numbers.** The Germanic assault order of battle at Rome (`siegeJuthungi`,
`src/sim/battleConfig.ts:465`), at establishment — `scaleAppliesTo('assault')` is false, and
at the default `ultra` tier the pool clamp does not bind either, so these are exact:

| | units | each | men |
|---|---:|---:|---:|
| `tower-assault` | 4 | 72 | 288 |
| `escalade-party` | 4 | 96 | 384 |
| `ram-crew` | 1 | 32 | 32 |
| `onager` | 3 | 12 | 36 |
| **siege train subtotal** | | | **740** |
| `juthungi-warband` | 6 | 180 | **1,080** |
| `juthungi-riders` | 2 | 50 | 100 |
| **total** | 20 | | **1,920** |

**1,180 is the whole Germanic army minus the siege train** — 1,920 − 740 — and it splits into
**1,080 foot warriors in six warbands plus 100 riders**. The distinction matters: the 1,080
warbands are exactly `StormPlan.host` (`src/sim/battleConfig.ts:258`) and are the men who
*could* climb and are never asked to; the 100 riders could not be given a storm order even by
a human, because `Siege.mayClimb` refuses `heavy-cavalry` and `light-cavalry` outright
(`src/sim/Siege.ts:2292`) — you cannot lead a horse up eight metres of rungs.

So: **1,080 warriors who can climb never receive a storm order.** The 1,180 figure is right
about the body of men left over once the machines are counted out, but 100 of them are horse.

The AI also cannot issue any siege verb at all. `Siege.requestMachineOrder` is
"deliberately player-only" (`src/sim/Siege.ts:2522`), on the reasoning that a machine verb
wired into `interceptOrders` is a verb the AI can fire as well. The one accidental route into
a storm — `Siege.interceptOrders` reading a ground move order whose *destination* lands on the
wall footprint as an escalade request — is never triggered, because no AI destination is ever
a parapet point.

### `GeneralAI`

`GeneralAISystem` (`src/ai/GeneralAI.ts:261`, order 45) is one plan per faction: a phase
machine (`deploy → skirmish → advance → engagement → exploit → pursuit`, with `withdraw` as
an override) that writes a `UnitCommand` per unit into `world.commands` — role, station,
facing, preferred target, aggression, pace, pursuit permission. It never emits an
`orderIssued`; `TacticalAI` never writes a `UnitCommand`. The blackboard map is the whole
handoff.

Doctrine is per faction: `germanic-shock` for the Juthungi, `roman-attrition` for everyone
else including Carthage (`src/ai/GeneralAI.ts:100`).

Both systems run in every scenario; there is no per-scenario branch. What varies is only
which factions each commands.

### `WallDoctrine`

`src/ai/WallDoctrine.ts` is **not** a subsystem — it is a plain helper class held by
`TacticalAISystem` and attached once in `init`. It owns the geometry and the rules for what
an army does with a wall it is *already standing on*.

It was written against a measured failure: `MarchToStation` gave garrison units ordinary
ground destinations, `Siege.interceptOrders` read those as "come down", and the Carthaginian
garrison fell from **448 men on the parapet at t+87 to 69 at t+250**. It did not die on the
walk — it left.

Four rules in strict priority order (`src/ai/TacticalAI.ts:1191`):

1. Enemy on the parapet within `FIGHT_R = 30` m → hold and fight where you stand. Implemented
   as *withdrawing the bid* (`return false`), so `engage` or `brace` wins the slot instead.
2. Enemy on the ground *inside* the curtain, `BREAK_IN_MEN = 25` or more → descend the stairs
   at him.
3. Enemy on the parapet within `REACH_R = 150` m → walk the wall to him.
4. Otherwise hold.

Rule 2 above rule 3 is deliberate. `inside(x, z)` is answered against the *nearest flight's
own outward normal*, so a curved circuit is read locally; on a map with no city everything
reads as outside, which makes rule 2 unreachable — the right failure.

`ORDER_COOLDOWN = 60` ticks (2 s) has the longest justification in the file:
`OrderBook.reconcile` cannot help here, because `Siege.interceptOrders` always puts a wall
unit back on `UnitOrder.Garrison`, so the book forgets the order every tick and the descent
plan's age resets to zero for ever.

### AI and determinism

The AI layer draws from exactly **two** RNG call sites in the whole of `src/ai`:

- `src/ai/TacticalAI.ts:1541` — `this.rng.next() < c.prof.spearAwareness`, the "don't charge
  the points" check, so a worse AI sometimes does it anyway.
- `src/ai/GeneralAI.ts:815` — breaking a dead heat between two wings, with the comment "not
  Math.random".

Everything else is deterministic by construction: both systems keep their own `this.tick++`
rather than reading a clock and discard `dt` entirely; think staggering is `unitId %
thinkInterval`, not a random offset; `AIWorld.activeFactions()` exists specifically to give a
stable iteration order, because a `Set`'s insertion order would depend on spawn order; and
`AIWorld.refresh` is guarded idempotent per tick so it does not matter which of the two
systems reaches it first.

`AIProfile` is the only wall-clock read, is off unless the F3 overlay is on, and is read back
only by that overlay.

---

## Known defects and gaps

Collected so they are not buried. Everything here is verified against `6698e19`.

**1. `Time.alpha` is documented as `[0,1)` and reaches 5.0.**
`src/core/Time.ts:23`. Once a frame's scaled delta exceeds `maxStepsPerFrame * fixedDt`
(166.67 ms — a 6 fps frame at 1x, **41.7 ms / 24 fps at 4x**), the backlog clamp parks the
accumulator at `fixedDt * 5` and `alpha` becomes exactly 5. `renderPos` and `renderFacing`
then extrapolate soldiers five ticks ahead of the simulation. No consumer clamps it
(`UnitRenderSystem.ts:2000`, `Projectiles.ts:2856`, `Banners.ts:469`). Measured; see the
table in §2.

**2. `SpatialHash.query` does not pass what its doc comment says it passes.**
`src/sim/types.ts:728` promises the callback "the candidate index and squared distance";
`:747` passes `r2`, the squared *radius*, which is the same value for every candidate.
Currently inert — all nine call sites take a one-argument callback and compute their own
`d2` — but it is a trap laid for the next person who trusts the signature.

**3. The N-short-advances equivalence is asserted in two comments and tested by nothing.**
`src/core/Engine.ts:514` and `src/core/Time.ts:109` both say it is "exactly what determinism
tests compare". No tool compares it. Both arms of `qa-determinism.mjs` use the same schedule.
I verified the property holds by hand (§2), but nothing would catch a regression.

**4. The divergence localisation in `qa-determinism.mjs` reads the wrong moment.**
`run()` advances each page through every checkpoint before returning, so `__poolDump()` is
called with both pages at the *last* checkpoint while the output is labelled with the *first*
diverging one (`tools/qa-determinism.mjs:151-169`). Unless those coincide, the soldier
indices, fields and percentage shown are the end state under the wrong heading.

**5. `--until` is documented and unread; `--at` is real and undocumented.**
`tools/qa-determinism.mjs:14`.

**6. The state hash is duplicated, not shared.**
`tools/qa-determinism.mjs:67` and `tools/qa-deploy.mjs:1010` define the same FNV-1a
byte-for-byte with no shared module, and both hardcode `10`/`11` for `Dying`/`Dead` instead
of importing `SoldierState`. Renumbering the enum would silently break the `alive` count in
both gates; changing one hash would silently desync them.

**7. The two gates assert on different fields.**
`qa-determinism.mjs` compares `hash`, `count`, `alive` and ignores `simTime`;
`qa-deploy.mjs` compares `hash`, `count`, `sim` and ignores `alive`. Neither compares all
four.

**8. The determinism rule has no automated enforcement.** No ESLint, no CI, no grep check.
See §5. The codebase complies today; nothing would tell you when it stopped.

**9. `RagdollSystem.fixedUpdate` reads the camera.**
`src/sim/Ragdoll.ts:268`. Safe only because the system writes nothing back into
`SoldierPool` — verified, there is no assignment to any pool array in the file. Worth knowing
before you add a write to it.

**10. `CROWD_HARD_CAP`'s comment and its value disagree.**
`src/sim/Combat.ts:83` says "Three is the most that can physically get at one man"; the
constant is `4`, and the test is `if (crowd >= CROWD_HARD_CAP) return`, so a man with three
attackers can still be taken by a fourth. Either the comment or the constant is wrong; the
behaviour is four.

**11. `DEFAULT_CONFIG`'s own headcount comment is 12 men out.**
`src/sim/battleConfig.ts:403` says "3,784 against 4,860". The measured pool is **3,772**
against 4,860 for a total of **8,632**, and the arithmetic in §3 confirms it: the 12-man
difference is the scorpion battery, which `spawnUnit` and `summarise` both exempt from the
unit-size multiplier. `src/sim/BattleFlow.ts:43` already quotes the correct 3,772.

**12. `MoraleSystem` is hard-wired to two sides.**
`src/sim/Morale.ts:328` bins by `faction === Faction.Rome ? 0 : 1`, and `deployed`, `power`
and `brokenShare` are all two-element tuples. Correct for every battle the game can currently
produce; wrong the day two non-Roman armies meet. `BattleFlowSystem` has already been
generalised past this and `BattleSystem.strength` was deliberately typed
`Record<Faction, number>` to make exactly this class of mistake a compile error.

**13. The AI cannot storm a wall.** See §9. On the Rome assault, 1,080 Juthungi warriors who
are eligible to climb never receive an order to.

### Things I could not verify

- **Whether the Juthungi host is *entirely* idle in the field, as opposed to merely never
  storming.** The three locks above are structural and I verified all three by reading them.
  But the host does receive ordinary `move` and `formation` orders from `MarchToStation`, and
  where the general's line ends up depends on `enemyLine()`'s cluster resolving onto Rome's
  two non-garrisoned reserve cohorts *inside* the walls. Determining the runtime outcome
  needs a run of `tools/probe-wallai.mjs`, which I did not do.
- **The measured figures quoted from source comments** — the 606→170 garrison plateau, the
  bay-18/bay-19 shoulder measurement, the 63.9%→19.3% friendly-fire figures, the
  `probe-meleegeom.mjs` rank distances, the Rome II reference values. These are reproduced
  here as the code's own record of why a constant has the value it has. I read them; I did
  not re-run the probes that produced them.
- **Whether the `alpha > 1` extrapolation is visible in play at 4x on target hardware.** The
  arithmetic and the threshold are certain; whether a real session at 4x crosses 41.7 ms
  often enough to see it is a measurement I did not take.
