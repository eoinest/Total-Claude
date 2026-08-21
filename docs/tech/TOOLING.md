# Tooling and verification

How this project checks that it is telling the truth, written for somebody who has to add a
check or work out why one is failing.

Nothing here is a unit test. There is no test runner and no `describe` block in the
repository. Every check in `tools/` boots the real application in a real browser with a real
WebGL context, drives it with real input events, and asserts on numbers read back out of the
running simulation. That is a deliberate choice with a specific cost and a specific payoff,
and both are covered below.

---

## The rule that belongs at the top

**Roughly as many defects in this project have been in the instruments as in the product.**

This is not a joke about test flakiness. These are measurements that were confidently wrong,
that changed decisions, and that in several cases reversed the sign of a conclusion. A
partial list, every one of them recorded in the tree:

| The instrument | What it reported | What was true |
|---|---|---|
| `tools/shoot.mjs` timing loop | frame times inflated ~2.4x — 22.68 ms at `melee` | 9.37 ms at a true 1/60 s frame. The loop fed the engine `elapsed * 1000 + 16.7`, a timestamp recomputed from the clock the previous call had just advanced, charging five sim ticks per rendered frame (`5363ae8`) |
| Penetration probes (`probe-nav`, `probe-melee`) | zero units passing through the walls | The men were graded against the *obstacle set*, and the obstacle set was the thing that was wrong. Found by measuring the drawn stone instead — `tools/probe-solid.mjs` casts against the baked chunks |
| `waitForFunction` across the tool directory | "the app never became ready" | The boot was merely slow. `waitForFunction(fn, { timeout: N })` passes the options object as Playwright's `arg`, so every intended 120–300 s wait silently used the 30 s default (`60a3f9c`) |
| `PostFX` depth of field, under the shot harness | a blurred near half of the field on a 480 m strategic overview | `dofAmount` read `ctx.rig.zoom`, which is a faithful proxy for orbit radius for a player and not for a harness — and `shoot.mjs` pins `zoom` to 0 so its metres-and-degrees camera has known constants (`1d9dd18`) |
| The first Carthage ditch probe | 0.83 m of relief against the 6.00 m the works publish | It sampled the gate bay's own outward normal. A ditch is bridged at its gate; that is a measurement taken down the middle of the road that crosses the thing being measured |
| A branch's `qa-deploy` control arm | 26/28, "not introduced by my diff" | Already fixed upstream. The control was pinned to the merge-base, which cannot distinguish those two. Rebased, the branch was 28/28 |
| The `waitForFunction` audit *in this document* | 19 surviving call sites | **9.** Eight of the fourteen it named in `tools/` already passed three arguments and were never broken. The counter asked "is the second argument the literal `null`?" rather than "is the options object in the argument position?" — an instrument written to check an instrument, wrong in the safe direction. `tools/check-tool-args.mjs` now answers it |
| `node tools/shoot.mjs` with no arguments | the 18 graded field shots at `3f4c203` | 32, because `'ab2-…'.startsWith('ab-')` is false. Fourteen A/B plates at a 240 s boot each, shot by every default invocation since `ab2-` was added |

The last row generalises into a rule the project writes down: **pin a control arm to `main`,
never to the merge-base.** A base arm at the branch point fails identically whether the fault
is pre-existing or has since been fixed, and those are opposite findings.

### The heuristic that catches them

> **A number that cannot be true given its neighbour.**

`docs/HANDOFF.md` enumerates four silent no-ops caught this way: a probe arm reporting 0.000
beside a sibling reporting 9.7 (it flipped `renderer.shadowMap.enabled` without a recompile,
and `USE_SHADOWMAP` is compile-time); the sun scoring as a *negative* light contributor; a
metalness delta of exactly `0.0000` on a material that already shipped `metalness: 1`; and a
stale uniform lookup after a rename. In every case the arm never ran. Further instances are
recorded outside that count — a shadow-pass arm reporting *exactly zero* draw calls, "0.3 ms
for nineteen 1080p targets", and a harbour audit printing a freeboard that could not be true
beside its neighbour, where "the ground never moved, only the instrument did".

**Check the shape of a number before its value.** An exact zero, an exact round figure, a
delta of precisely 0.0000, or a value that its own neighbour contradicts are all more likely
to be an arm that never executed than a real result.

### Today's example, and why it is the perfect one

A live-boot check reported all three maps — `campus-martius`, `carthage`, `pydna` — dead,
with **zero page errors and zero console errors**. That combination is the tell. A genuinely
broken build produces errors; silence with a failure means the probe never reached the thing
it was measuring.

Two faults, both in the probe:

1. **No `?menu=0`.** `src/main.ts:70` reads
   `const skipMenu = harness || params.get('menu') === '0';`, and the menu is shown at module
   top level *before* `window.__game` is assigned. Without the parameter the page sits
   correctly on the main menu, `window.__game` is `undefined`, `ready` never becomes true —
   and nothing throws. "All three maps dead, no errors" is the signature of that mistake, not
   of a dead build.
2. **`simTime` read as a property.** It is a function: `src/main.ts` declares
   `simTime(): number` and implements it as `simTime: () => engine.time.simTime`. Reading the
   property yields the function object, which is non-null and never changes, so a
   "did the clock move?" check on it is nonsense that always answers the same way.

Both are fixed in `tools/scratch/r6-liveboot.mjs`, which now navigates to
`?map=<id>&menu=0` and calls `window.__game?.simTime?.()`.

> **Worth fixing upstream:** `docs/RELEASING.md` step 3 is the procedure this probe
> implements, and it describes loading `?map=campus-martius`, `?map=pydna` and `?map=carthage`
> against the live URL without ever mentioning `?menu=0`, and says to "read
> `window.__game.ready`" and "read the simulation clock twice" without naming `simTime()` as a
> call. Followed literally against a non-harness URL, every map fails. The document taught the
> defect.

---

## The shape of every harness here

They are all the same programme, and knowing it makes an unfamiliar one readable in a minute.

```js
// 1. Find or start a dev server on this tool's OWN port.
const base = `http://127.0.0.1:${PORT}`;
if (!(await waitForServer(base, 1200))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } });
}
// 2. Launch Chromium with a real GPU path.
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
// 3. Boot, wait for the game's own ready flag — with `null` in the arg position.
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
// 4. Drive it with real events, assert on state read back out of `window.__game`.
// 5. record(name, pass, what, changed, note) → console, and optionally --json.
// 6. process.exit(failed === 0 ? 0 : 1)
```

Four conventions follow from that, and breaking any of them has cost this project a day.

**`TC_NO_HMR=1` is not optional.** `vite.config.ts` disables HMR when it sees that variable.
Without it, an agent editing a file mid-run reloads the page and destroys the execution
context, which surfaces as a spurious "page crashed" at a random simulation time.

**`null` goes in the second argument of `waitForFunction`.** Playwright's signature is
`waitForFunction(pageFunction, arg, options)`. Passing `{ timeout: N }` in the second position
makes it the *argument to the function*, and the 30 s default silently applies. The correct
form is `waitForFunction(fn, null, { timeout: 180000 })`. This bug was fixed across the tool
directory in `60a3f9c` — whose message says nineteen tools while its diff converts 17 call
sites in 14 files — and **it was not fixed everywhere.**

There is now a check, and you should run it rather than grep: `node tools/check-tool-args.mjs`,
wired into `npm run lint`. It matches parentheses over a comment- and string-aware lexer
(`tools/lib/jsscan.mjs`), so a call spanning any number of lines is counted correctly, and
`--fix` repairs the ones it finds. **At `3f4c203` it found 9 violations in 160 call sites** —
`probe-carthage-wall.mjs:81` and `:1103`, `probe-ram.mjs:42`, `probe-towerpass.mjs:347`,
`probe-walltraffic.mjs:215`, `qa-audio.mjs:154`, and three under `scratch/` — all now fixed.

**This document previously published a list of 19, and eight of the fourteen it named in
`tools/` were never broken.** `banner-check.mjs:715`, `grab-video-frames.mjs:206`,
`matchup.mjs:413`, `probe-melee.mjs:124`, `probe-meleegeom.mjs:286`, `probe-shimmer.mjs:70`,
`probe-siege.mjs:300` and `probe-wall.mjs:157` all pass three arguments; the signature is
`(pageFunction, arg, options)` and `null`, `undefined` and `{}` are equally fine in the
argument slot. The counter had asked "is the second argument the literal `null`?" instead of
"is the options object in the argument position?" — wrong in the safe direction, which is still
wrong, and a list of 19 with 8 non-bugs in it teaches the reader to distrust the other 11.
`node tools/check-tool-args.mjs --explain` prints that correction.

A single-line grep finds 3 of the 9. That is why the check exists and the grep does not.

**Never touch port 5173.** `vite.config.ts` pins the game's interactive dev server there and
it belongs to whoever is playtesting. Every harness carries its own default in the 5199–5847
range and passes `--port … --strictPort`, which overrides the config. `probe-adaptive.mjs`
states the rule out loud: *"start your own, never touch 5173"*. No `tools/qa-*.mjs` defaults
to 5173, and the only way to reach it is to pass `--port=5173` yourself.

**Drive the product, never the function under it.** From `qa-deploy.mjs`'s own header:

> Every check below fires a real Playwright mouse or keyboard event at real screen
> coordinates and then asserts on state read back out of `window.__game`. Nothing calls a
> placement function directly — a test that did would pass while the feature was unreachable,
> and that exact gap shipped a broken wall-descent feature on this project.

`qa-wallattack.mjs` takes the same idea one step further and grades screen-to-ground picking
against `window.__marchGround`, an independent half-metre forward ray march that deliberately
shares no code with `picking.screenToGround`, on the stated grounds that *"grading a function
against itself is how this project has shipped a silent no-op before"*.

---

## The harnesses

### `tools/qa-deploy.mjs` — the pre-battle deployment phase

The broadest gate in the repository and the one branches are scored against. **28 checks in
four arms**, driven the way a player drives them.

```sh
node tools/qa-deploy.mjs                       # all four arms, port 5311
node tools/qa-deploy.mjs --only=wall           # one arm
node tools/qa-deploy.mjs --json=/tmp/qa.json --shots=/tmp/qa-shots
```

| Arm | `--only=` | Checks | What it covers |
|---|---|---|---|
| menu | `menu` | 3 | The true player path — no `?harness`, click BEGIN BATTLE in the real menu, and check the phase you land in |
| field | `field` | 14 | Select, drag to place, facing, frontage, formation key, remove, add, delete, commit, and that placement survives the start |
| wall | `wall` | 9 | Drop a ground unit on the parapet and measure where its men ended up |
| det | `det` | 2 | Determinism through a *hand-placed* deployment |

The wall arm is the interesting one: it measures the result against
`CitySystem.getGarrisonBays()` — the city's own published numbers — rather than against the
siege system's internals, so the two subsystems have to agree rather than one grading itself.
`wall-height` asserts every man's feet against the bay's published `walkY`, and separately
that none are inside the masonry.

The `det` arm is two checks and they are reported separately on purpose:
`deployment-reproduced` asks whether the *harness* put the unit in the same place twice, and
`deployed-battle-replays` asks whether the *simulation* then produced the same pool hash. Only
the second is a bug in the product. The comment explaining why is worth reading before you
write any determinism check:

> A drag's frontage is the length of the line the pointer actually travelled, and the number
> of `pointermove` events a browser delivers over a 260 px path is not a constant — a busy
> machine coalesces them. Measured: two runs of this arm placed the same unit at widths one
> apart, which is a different formation, which is a different t+0 hash, and the arm then
> reported determinism broken when what had differed was the input.

It also stops the rAF loop *before* pressing BEGIN and advances by hand, because stopping it
after leaves however many real frames occur between the click and the `evaluate`: run A
reached sim 0.233 s and run B 0.200 s before either had been advanced at all.

**Reading a failure.** Every check prints two lines — the assertion, then what was actually
observed:

```
  PASS  wall-height              every man's feet against the bay's own published walkY
        → walkY 41.8 m, men span y 41.8..41.8, worst |Δy| 0 m, 0 inside the masonry
```

The second line is the diagnosis. Take `--json` and `--shots` on any run you intend to argue
about; `measured.determinism` in the JSON carries both runs' hashes at t+0, t+30 and t+90.

### `tools/qa-determinism.mjs` — bit-identical replay at scale

Two independent page loads, rAF stopped, advanced by an identical fixed-step schedule, hashed
with FNV-1a over the raw float bits of every soldier's `x`, `z`, `state` and `hp`. Bit
patterns, not `toFixed()` — a 1-ULP drift is caught rather than rounded away.

```sh
node tools/qa-determinism.mjs                                   # port 5226, default battle
node tools/qa-determinism.mjs --at=0,30,90,150,200              # checkpoints, in sim seconds
node tools/qa-determinism.mjs --battle='map=carthage&scenario=assault'
node tools/qa-determinism.mjs --json=/tmp/det.json
```

`--battle` appends query parameters, which matters now there are two besiegeable cities: an
assault takes an entirely different path through `deployAssault` and `Siege`, and a garrison
pinned to a wall-walk is the part of the sim least like the field battle this gate has always
measured.

**Reading a failure.** It does the localisation for you. On divergence it dumps both pools and
reports how many soldiers differ, as a count and a percentage, then names the first twelve by
index and unit with the exact fields that differ:

```
  8/8970 soldiers differ (0.09%)
    soldier  1204 (unit 7): x 512.3319 vs 512.3320
```

A handful of soldiers differing points at one system; thousands points at the schedule or the
clock. The final line is `✓ deterministic across N checkpoints at M soldiers` or
`✗ determinism BROKEN at N/M checkpoints`.

**~~Known fault in this instrument: the hash exists twice.~~ Fixed — and it went into the
product, not into `tools/lib/`.** It used to be that `qa-determinism.mjs` and the `det` arm of
`qa-deploy.mjs` each carried their own copy of `window.__poolHash` as a source string, that
the two had *already* drifted cosmetically, and that both hardcoded `SoldierState.Dying` and
`Dead` as the literals `10` and `11` with no way to import the enum, because the hash ran in
the browser and `SoldierState` was not on `window.__game` at all.

The arithmetic now lives in **`src/sim/stateHash.ts`** and both tools reach it through
`window.__game.hashes()`. `tools/qa-replay.mjs` is the third consumer and the reason this was
worth doing: a replay gate carrying its own fourth copy of those forty lines is a gate that
can pass while the other two fail. The enum is spelled once, in a file that can see it.

Two things about that file are deliberate and must survive any tidying:

- **`poolHash` is not FNV-1a and must not be "fixed" into it.** It multiplies with
  `h = (h * 0x01000193) >>> 0`, and above 2^53 that float product rounds — about 87.5% of the
  products do. Twenty-one recorded hashes in `determinism-baseline.json` are keyed to exactly
  that rounding. `unitHash`, written later with nothing pinned to it, *is* real FNV-1a via
  `Math.imul`. The two being different is load-bearing.
- **`hashes()` computes both halves in one pass.** The gate used to call `__poolHash()` and
  `__unitHash()` separately per checkpoint, which walked the pool and the unit array twice for
  one line of output.

Verified across the move: all three battles, all seven checkpoints, `hash`, `uf64` and `uctl`
unchanged.

### `tools/qa-replay.mjs` — the record, driven by a real mouse through the real menu

The instrument that can see an input path nobody told it about. **17 checks in seven arms** on
port 5245.

```sh
node tools/qa-replay.mjs                                  # all arms, 200 s of battle
node tools/qa-replay.mjs --only=record,replay --seconds=30   # the fast pair
node tools/qa-replay.mjs --json=/tmp/replay.json --shots=/tmp/replay-shots
```

`qa-determinism.mjs` loads one build twice and compares the two runs. That answers *does this
battle replay* and is structurally incapable of answering *did the player's input reach the
simulation through a path anybody recorded* — both of its runs take the same out-of-band
writes, in the same order, and agree perfectly. This file closes that gap: it boots through
the front door, the setup sheet, BEGIN BATTLE and the deployment plaque, drives a real mouse
and real keys, records what that produces, and replays the record in a fresh page.

| Arm | `--only=` | What it covers |
|---|---|---|
| record | `record` | The recorder saw the mouse: orders, keys, and the deployment plaque — and left the AI's thousands of orders on the bus where they belong |
| replay | `replay` | Every checkpoint bit-identical; the re-recorded log is byte-identical; same `BattleFlow.result` |
| coarse | `coarse` | The same battle at **five ticks a frame** instead of one every two |
| late | `late` | An order shifted 1/2/4/8 ticks — a ladder, reporting the smallest lateness the gate can see |
| bus | `bus` | An unrecorded `orderIssued` straight onto the bus, mid-battle — the twenty-fourth input path |
| write | `write` | A direct write to `UnitGroupState` from outside a tick |
| command | `command` | `?replay=…&from=<s>` — identical to the handover tick, then nothing fed |

**Three of the arms are failures if they go green.** `late`, `bus` and `write` break the battle
on purpose and are only useful as evidence that the gate can see the fault it exists to catch.

**Measured on the shipped field battle at `small`**: 226.1 s, 2,247 men, 34 recorded events,
2,809 B of JSON, **1,224 B gzipped**, a 1,632-character token — config 476 B, order log 451 B,
checkpoints 250 B when each is gzipped alone.

**Comparison is at an equal tick count, never an equal elapsed time.** `window.__game
.advanceTicks(n, stepMs)` runs exactly *n* ticks at whatever frame schedule is asked for,
using the `Time.tickCeiling` added for it — because at t+30 a 1000/60 step gives 900 ticks, a
166 ms step gives 901 and an exactly-five-tick 1000/6 step gives 899, and three earlier passes
compared those arms as though they were the same battle at the same moment.

### `tools/check-determinism.mjs` — the invariant that used to have no enforcement

[Simulation](SIMULATION.md#the-rule-and-how-far-it-is-actually-enforced) states the rule and
audits compliance with it call site by call site. This section is the check.

Until `3f4c203` **the determinism rule was enforced entirely by people remembering it.**
Re-verified rather than taken on report: no ESLint config, no Biome config, no `.github/`
directory, no CI workflow of any kind, and no `lint` script in `package.json`. `src/util/rand.ts`
states the rule in a comment and that comment was the whole mechanism. It is the single most
load-bearing invariant in the codebase.

```sh
npm run lint                       # check-determinism, then check-tool-args
node tools/check-determinism.mjs --verbose      # show what was cleared, and why
node tools/check-determinism.mjs --scope=src/sim,src/ai,src/units,src/city
```

Milliseconds, no browser, no server, no dependency, and it runs ahead of `npm run build`.
It reproduces the price an earlier pass put on it exactly:

| | |
|---|---|
| Scope | `src/sim`, `src/ai`, `src/units` — 39 files. `Math.random()`, `Date.now()`, `new Date(`, `performance.now()` |
| Result at `3f4c203` | **12 raw hits, 10 cleared by the profiling pattern, 2 allowlisted, 0 violations** |
| Allowlist | Two entries, both `src/ai/profile.ts`, both pinned to the **exact source line** — edit the line and the hit comes back. An allowlist keyed on a file or a line number silently covers whatever is written there next |
| Comment handling | It blanks comments and string bodies before matching, which is why the answer is 12 and a raw grep says 15. Three of those 15 are comments *forbidding* `Math.random()` |

**The profiling pattern is a pairing, not a shape.** `const t0 = performance.now()` clears only
if a `… = performance.now() - t0` exists in the same file *and `t0` has no other use at all*.
That clause is load-bearing and there is a live example: point the tool at `src/ui` and
`HudSystem.ts:460` is reported, correctly, because its `t0` also feeds
`const dt = t0 - this.lastFrameAt` and `this.lastFrameAt = t0`. A wall-clock value entering
program state is precisely what the rule bans, and a checker that whitelisted the `t0` *shape*
would have waved it through.

**What a PASS does not mean.** The tool prints this on every run, including a pass, and the
header says it at length:

- identity-keyed iteration order — `Set`/`Map` insertion order, object-keyed maps;
- unstable or non-total sorts, and sorts keyed on a float two runs can compute 1 ULP apart;
- floating-point differences from parallelism, SIMD, or a JIT tier change;
- non-deterministic *inputs* that are not calls — `RagdollSystem.fixedUpdate` reads the camera
  position, and its safety rests on write-isolation that nothing checks;
- a banned call reached through an alias, a helper outside the scope, or `globalThis`;
- every `fixedUpdate` outside the three scanned directories. `CitySystem`, `VFXSystem`,
  `AdaptiveQuality` and `Engine` all have one and none is scanned — `AdaptiveQuality`'s entire
  job is to read the clock. Directory scope is a *proxy* for "the simulation path" and it is
  wrong in both directions.

`qa-determinism.mjs` remains the only instrument that can see any of that. The static check
converts the cheapest class of future mistake from "found by an end-to-end gate somebody
remembered to run" into "found at build time", and it would have caught none of the determinism
bugs this project has actually had. It claims nothing beyond that, in its own output.

### `tools/qa-interact.mjs` — real mouse and keyboard

**33 checks** on port 5224, a fixed linear script of fourteen numbered blocks with no
`--only=` filter. Click-select, marquee, double-click-by-type, right-click move and attack,
right-drag frontage and yaw, the command panel, formation and ability buttons, speed keys,
`Space`, the `F3` and `L` overlays, the minimap, six camera-gesture sub-arms, the card bar,
and finally a **second page without `?harness=1`** that starts through the real pre-battle
menu and re-checks that the camera, wheel, drag and click all still work after it closes.

Its stated bar is the useful one: *"Anything that changes nothing measurable is reported as a
failure."*

```sh
node tools/qa-interact.mjs --json=/tmp/interact.json --shots=/tmp/interact-shots
```

**Reading a failure.** Same two-line format. Note that **console errors alone fail the run**
even at 33/33 — the exit is
`process.exit(failed || consoleErrors.length ? 1 : 0)` — so a green check list with a red exit
code means scroll down to the de-duplicated error dump. `--shots` writes six fixed-name PNGs
including `marquee.png`, `frontage-drag.png` and `middle-drag-pan.png`.

### `tools/qa-wallmatrix.mjs` — every route × direction × unit type

The combinatorial gate for commanding troops on a wall. Its contract is explicit: *"Nothing in
a cell calls a siege verb. The only page calls a cell makes are camera framing,
`engine.advance`, and read-only census."*

```sh
node tools/qa-wallmatrix.mjs --port=5477 --map=campus-martius
node tools/qa-wallmatrix.mjs --map=carthage --only=C1,C2 --json=/tmp/wm.json --shots=/tmp/wm
```

The unit of counting is a **cell**, not a check: up to 12 on Rome (`R1`, `R2`, `R2X`, `R2H`,
`R3`–`R8`, plus `B1` and `ERR`) and up to 11 on Carthage (`C1`–`C9`, `B1`, `ERR`). Each cell
names a `route` (`stairs | traverse | ladder | tower | halt | breach`) and a `dir`
(`up | along | down | through`). It does **not** start a server — it exits 2 if nothing is
already listening, on the grounds that a probe falling through to `dist/` measures a build
rather than the source.

**Reading a failure.** This harness has the best diagnostics in the repository, because the
two ways a cell fails are hard to tell apart from a screenshot:

- `SELECT FAILED` dumps the aim pixel, the DOM element stack under it walked up four levels,
  `overUi`, sim time, paused state, and every `#hud-root .interactive` overlay larger than
  400×300 — i.e. it names the panel that ate your click.
- `no camera resolved the target as <want>` reports what the cursor *did* resolve to:
  `wallValid` at `(wallX, wallZ)`, `solidValid`/`solidY`, the order point, and the cursor kind.
- Graded verdicts quote the live hint text and cursor glyph captured **while the right button
  is still held**, because the hint only exists during the gesture.

Two quirks to know before you read a summary line. `B1` records `pass: false, skip: true` when
no breach exists — it prints `SKIP` but still increments `failed` and exits 1. And several
cells (`R4`, `R5`, `R7`, `R8`, `C5`, `C9`) have no fallback record, so if their precondition is
absent they emit nothing at all and `cells.length` simply shrinks. **Compare the cell count
between runs, not just the pass count** — this is the same "a number that cannot be true given
its neighbour" check, applied to the denominator.

### `tools/qa-wallattack.mjs` — attacking men on a parapet

**11 checks** on port 5477, in three blocks: `G0` ordinary ground picking taken *before*
anything else touches the cursor, `G1` hovering an enemy on the parapet from the field with a
storming cohort selected, `G2` both units on the parapet, and then ground picking again, last,
as a drift check.

The repeated ground-picking check is the point of the file. A reverted solid-picking attempt
once collapsed every ground click onto one box 42–92 m away, so the check grades 12 canvas
pixels against the independent `window.__marchGround` ray march and passes only if there are
at least 8 rows, worst ground error under 2.0 m, worst order error under 2.0 m, **and a spread
greater than 200** across the twelve answers. That last term is what a collapse regression
cannot fake, and it is why the check is run twice with everything else in between.

### `tools/qa-preview.mjs` — production build parity

Renders the identical `wide` viewpoint from the dev server and from `vite preview` over
`dist/`, and compares them.

```sh
npm run build                                  # dist/ must exist; exits 2 otherwise
node tools/qa-preview.mjs                      # dev 5229, preview 4183
node tools/qa-preview.mjs --out=screenshots/qa
```

Eight assertion points: console errors on each side, that every `/assets/` request returned
200, that no un-optimised jpg/png survived into the bundle, identical draw calls, triangles
within 1%, `sky.environmentTexture` present in both, and a pixel diff refused above 12% of
pixels differing by more than 24/765.

The asset audit is the reason this exists. From its header: the build swaps 2K JPEGs for
resized WebP, and *"a single 404 there silently drops the game to a procedural fallback that
still 'works' — which is exactly how a broken deploy passes a smoke test."*

**Reading a failure.** Failures go to stderr as `✗ <message>` and each carries its own numbers.
There is **no `--json` flag**; it always writes `${OUT}/preview-parity.json` plus
`parity-dev.png` and `parity-preview.png`. It has no denominator — `pass()` only prints — so
the summary is `✓ production build parity holds` or `✗ N failure(s)`.

### The `probe-*` family

**66 files.** Where a `qa-*` harness is a pass/fail gate, a probe is a measuring instrument: it
prints numbers with tolerances and you decide what they mean. `probe-siege.mjs` states the
division well —

> A screenshot cannot show whether a man is standing *on* a wall-walk or hovering ten
> centimetres above it, sunk into the masonry, or standing on the terrain 8 m below with the
> wall drawn in front of him. That is what this measures.

They divide by convention rather than by name. 32 spawn their own vite server; 19 refuse to
run without one and exit 2 rather than fall through to a stale `dist/`. Default ports run from
5199 to 5847, mostly unique, with seven sharing 5477 (the wall family, which is never run
concurrently).

Ones worth knowing by name:

| Probe | Measures |
|---|---|
| `probe-solid.mjs` | Casts against the *baked chunks* — the drawn stone — rather than the obstacle set. The instrument that found the walls-are-permeable bug the obstacle-based probes all agreed did not exist |
| `probe-frametime.mjs` | The distribution, not the mean: p50/p90/p95/p99/max and counts over 16.7 and 33 ms, keeping the rAF delta and `engine.frame()` apart. "A stutter lives in p99 and in nothing else" |
| `probe-harshness.mjs` | Pixel-scale Laplacian energy over structure-scale, the ratio that separates aliased renders from filtered ones. `--jpegsweep` re-encodes at a range of qualities to check the ratio is actually immune to the plates' prior JPEG generation |
| `probe-ditch-ds.mjs` | Walks transects *perpendicular* to the wall at several stations, and excludes the gate causeway. See the top of this document for why |
| `probe-interactive.mjs` | Established the convention that the honest clock is a real rAF loop with real input, not a driver calling `engine.frame()` in a tight loop |

---

## Screenshot and grading tooling

### `tools/shoot.mjs` — the frames everything visual is judged on

> This is the ground truth the critic agents judge — nobody grades this project from source.

Boots the game in Chromium with a real WebGL context, fast-forwards to a chosen simulated
moment, parks the camera at a **named viewpoint** from the `SHOTS` table, and writes a PNG.

```sh
node tools/shoot.mjs --list        # at 385474f: 61 shots; deck 10, r6 3, ab1 14, ab2 14, all 20
node tools/shoot.mjs --shots=wide,romanline    # a subset
node tools/shoot.mjs --set=deck --out=/tmp/tc-ab/shots-r1
node tools/shoot.mjs --w=2560 --h=1440 --dpr=2
node tools/shoot.mjs --hud                     # WITH the interface — never gradeable
node tools/shoot.mjs --set=menu                # the front door and its destinations
```

#### `ui` shots: a screen, not a world

Every shot above loads `?harness=1`, which exists precisely to *skip* the menu, fast-forwards
a battle and parks a camera. A frame of a **screen** has no `at`, no camera, no world and no
`window.__game` to read numbers out of, so a shot may instead carry a `ui` block and take a
different branch entirely:

```js
'menu-setup': {
  desc: 'BATTLE clicked — the setup flow, unchanged',
  at: 0,
  ui: {
    url: '/',                                   // relative to the dev server, or absolute
    wait: '.menu.at-home .dest-battle',         // must be *visible* before anything is done
    steps: [{ click: '.dest-battle' }, { wait: '.menu .begin' }],
    settle: 700,                                // extra ms before the shutter
  },
},
```

Steps are `{click}`, `{key}`, `{wait}`, `{ready: 'game'|'viewer'}` and `{ms}`. `external: true`
marks a page this repository does not build — the published docs site — whose console errors
are printed but do not fail the pass, because adopting somebody else's analytics beacon as our
build failure is not a useful gate.

Each `ui` shot runs on **its own page**. The world page carries a console listener whose
findings fail the pass, a HUD-suppressing style tag and a `loadedKey` recording which world is
currently built; navigating it to a menu would invalidate all three, quietly.

> **These frames are interface top to bottom and there are two guards, not one.** `menu` is a
> declared family, so `--set=all` does not shoot them; and any pass that takes a `ui` frame
> writes `blindSafe: false` into `report.json` whatever `--hud` said. One of those guards is a
> naming convention, which is exactly the kind of thing leak six got past.

An `ui` shot's page is loaded with **no flags at all** — no `?harness=1`, no `?menu=0`, no
`?menu=battle` — so `menu-battle` walks the door, the setup screen and BEGIN BATTLE and then
waits on a real world build. It is the one frame in that set that costs a boot.

> **A defect in this table, found while checking the numbers for this document, since fixed.**
> `--set` is `all` when you pass nothing, and `all` was defined as *"not `deck-` and not
> `ab-`"*. But `'ab2-rome-line'.startsWith('ab-')` is **false** — the third character is `2`,
> not `-` — so the default set was 32 shots, 14 of them the round-two A/B frames with their
> matched press cameras and their 240 s boots. `ab1`'s filter carried a redundant
> `&& !k.startsWith('ab2-')`: the ambiguity had been noticed once and guarded on the side that
> did not need it.
>
> **The fix is not the missing `startsWith`.** A shot's family is now the first
> hyphen-delimited segment of its key, matched by *equality* against a `FAMILIES` registry — so
> `ab2` is not `ab`, and a future `ab3` will not be either — and every set including `all` is
> derived from one `familyOf`, so the sets partition the table exactly (at `385474f`,
> `10 + 3 + 14 + 14 + 20 = 61`). Every run now prints the set and the frame count as its first
> line, which is the part that would actually have caught this.
>
> `checkFamilies` is **fatal** on an undeclared segment that extends a declared family name
> (`ab3` beside `ab`) and merely **advisory** on three or more shots sharing any other
> undeclared segment. It is two severities because the first draft was one, was clean at
> `3f4c203`, and would have exited 2 on every invocation once `main` landed
> `carth-postern-wide` and `carth-postern-close` — two ordinary field shots that share a
> topic prefix. A guard that refuses a legitimate tree is worse than the leak it closes, and
> that one was caught only by merging `main` before reporting.
>
> Nothing programmatic depended on the old meaning: no tool spawns or imports `shoot.mjs`, and
> the whole dependent surface was four documented invocations with no `--set`.

### `--set=ab3`: round three

Generated from `ab2` entry for entry, in code, so the two cannot drift. **Exactly two fields
move: the hour and the weather.** Round two's `cam` blocks were measured against the plates
they are paired with, and re-deriving them would give a round that cannot distinguish "the
soldiers are better" from "the photographer is different".

The hour moves because the `ab2` block's own claim — *"no two are within twenty minutes"* — is
false. Sorted, its hours are 8.6, 9.0, 10.2, 11.0, 11.5, 12.2, 12.8, **13.0**, 13.4, 14.3,
15.0, **15.2**, **15.4**, 17.6: three gaps of 0.2 h, which is twelve minutes, and four of the
fourteen inside a 24-minute band in the middle of the afternoon. `ab3` spans 7.3 to 17.7 with
a half-hour floor, checked by a throw in the file rather than asserted in a comment. Counts
are unchanged at nine clear, four overcast and one rain.

This matters *less* this round than it did last, and is worth fixing anyway. Under one grader
per pair nothing a grader sees can cluster — they get one frame of ours and cannot learn our
sun from it. The clustering was a defect of the pooled reading, and the pooled reading is what
round three replaces. It is fixed because the deck outlives the protocol, and because a deck
whose comment says one thing and whose data says another is a deck nobody can trust the rest
of.

**Use a named camera. Never hand-place one.** This is the single most important convention in
the visual tooling and it is not about tidiness. The point of a shot is that the "after" is
*the same frame* as the "before" and not merely a similar one, and a hand-placed focus cannot
give you that — it goes stale the moment the order of battle, the terrain or the deployment
changes. The table records this happening: `romanline` had a fixed focus, the line moved, and
the shot "ended up in the top-left corner with 90% of the frame full of grass". Shots
therefore name a *follow target* (`ownLine`, `contact`, `unitType`, `enemyFront`) and the
camera is auto-framed on it.

That machinery is itself a source of instrument defects, and the fix pattern is recorded on
the branch tip at `6698e19`: `follow: 'contact'` means "the densest cell of anything fighting",
which on Carthage at t+96 is a cavalry clash on a flank, so a shot meant to photograph an
infantry melee came back as a wall of horses. And "frontmost of the accepted classes" picks a
*skirmisher* every time, because standing in front of the line is a skirmisher's job. The
commit message names the check that works:

> The check that works is the focus coordinate in the shot line: it was (75,-130) before the
> first fix and (75,-130) after it, which said the fix was inert in one glance and would have
> said so before the frame was ever looked at.

Round two's A/B shots go further and bypass the zoom curve entirely, naming what a
photographer names — `eye` and `aim` in metres above the ground at the focus, `dist` in metres,
and a field of view in degrees. The reason is in the block comment: `RTSCamera.place()` refuses
to let the eye sit closer to the ground than `lerp(1.7, 22, smoothstep(z))`, so at `zoom: 0.34`
the curve asks for an eye 2.8 m up and the clamp overrides it to 7.2 m while the aim point
stays on the grass — a true depression of 25° where the reference plates sit at 3–8°. *"The
camera is not high because anyone chose a high camera. It is high because a collision guard
said so."*

**`report.json` is provenance, not a log.** Every run writes one, and `hud: <bool>` is the
field that matters: `false` means the directory is safe to grade blind, `true` means it is
not, and *missing* means nobody knows. All three are distinct and the deck builders refuse the
third as firmly as the second. The record also carries `commit` and `srcTree` — the tree object
of `src/`, because a shot table is not a renderer and `COMMIT` moves when a table is retuned.
A partial re-shoot **merges by shot name** and refuses to merge across anything that has to be
uniform for the frames to belong in one deck: HUD policy, pixel ratio, frame size, quality
tier and `srcTree`. *"A mixed-commit directory is not a pass, it is two passes in a trench
coat."*

**Use a named camera. Never hand-place one.** This is the single most important convention in
the visual tooling and it is not about tidiness. The point of a shot is that the "after" is
*the same frame* as the "before" and not merely a similar one, and a hand-placed focus cannot
give you that — it goes stale the moment the order of battle, the terrain or the deployment
changes. The table records this happening: `romanline` had a fixed focus, the line moved, and
the shot "ended up in the top-left corner with 90% of the frame full of grass". Shots
therefore name a *follow target* (`ownLine`, `contact`, `unitType`, `enemyFront`) and the
camera is auto-framed on it.

That machinery is itself a source of instrument defects, and the fix pattern is recorded on
the branch tip at `6698e19`: `follow: 'contact'` means "the densest cell of anything fighting",
which on Carthage at t+96 is a cavalry clash on a flank, so a shot meant to photograph an
infantry melee came back as a wall of horses. And "frontmost of the accepted classes" picks a
*skirmisher* every time, because standing in front of the line is a skirmisher's job. The
commit message names the check that works:

> The check that works is the focus coordinate in the shot line: it was (75,-130) before the
> first fix and (75,-130) after it, which said the fix was inert in one glance and would have
> said so before the frame was ever looked at.

Round two's A/B shots go further and bypass the zoom curve entirely, naming what a
photographer names — `eye` and `aim` in metres above the ground at the focus, `dist` in metres,
and a field of view in degrees. The reason is in the block comment: `RTSCamera.place()` refuses
to let the eye sit closer to the ground than `lerp(1.7, 22, smoothstep(z))`, so at `zoom: 0.34`
the curve asks for an eye 2.8 m up and the clamp overrides it to 7.2 m while the aim point
stays on the grass — a true depression of 25° where the reference plates sit at 3–8°. *"The
camera is not high because anyone chose a high camera. It is high because a collision guard
said so."*

**`report.json` is provenance, not a log.** Every run writes one, and `hud: <bool>` is the
field that matters: `false` means the directory is safe to grade blind, `true` means it is
not, and *missing* means nobody knows. All three are distinct and the deck builders refuse the
third as firmly as the second. The record also carries `commit` and `srcTree` — the tree object
of `src/`, because a shot table is not a renderer and `COMMIT` moves when a table is retuned.
A partial re-shoot **merges by shot name** and refuses to merge across anything that has to be
uniform for the frames to belong in one deck: HUD policy, pixel ratio, frame size, quality
tier and `srcTree`. *"A mixed-commit directory is not a pass, it is two passes in a trench
coat."*

### `tools/pair-deck.mjs`, `tools/blind-compare.mjs`, `tools/lib/deck-audit.mjs`

Two deck builders and the shared audit battery.

- **`blind-compare.mjs`** builds the **pooled** instrument: one shuffled line-up of twenty
  frames a grader sorts wholesale.
- **`pair-deck.mjs`** builds the **paired** instrument: `NN-A.png` / `NN-B.png`, one of ours
  and one real Rome II frame of the same subject, side randomised.
- **`tools/lib/deck-audit.mjs`** holds the leak audits, lifted out of `blind-compare.mjs` so a
  second deck builder cannot quietly ship a weaker copy of them, *"and at least two of those
  leaks were 'the other tool did not have that check yet'."* It also holds `LEAKS`, the
  register, which is the single source for the count — `node tools/blind-compare.mjs --leaks`
  prints it. **Eight leaks: six refused by a gate, one (the wordmark) mitigated by construction
  with no gate behind it, one open.** The two files used to say eight and seven respectively;
  the seven were the closed ones, and leak eight — the true JPEG scan length recovered past the
  pad, 0.850 balanced accuracy — cannot be closed by the harness at all.

---

## The blind A/B instrument

The most carefully designed thing in this repository, and the one with the most hard-won
detail. Read this section before you touch either deck builder.

### What it is for

> A critic told "grade our screenshot" grades charitably, and a critic shown our frame beside
> a labelled Rome II frame grades the label. Neither measures what we want, which is: *can a
> hostile expert pick ours out of a line-up, and on what evidence?*

Decks pair our frames against Total War: ROME II press screenshots. Graders never see the
mapping. The answer key is written **outside the deck tree** and `pair-deck.mjs` refuses
outright if you point `--key` inside `--out`:

```
REFUSED: the answer key would land inside the deck directory. That is leak three.
```

The paired form has one property the pool does not: **subject is controlled inside the trial.**
In a pool, "the frame with the war elephants is Rome II" is a correct call that says nothing
about our renderer. In a pair, the plate beside our elephants is Rome II's elephants.

```sh
node tools/shoot.mjs --set=ab2 --out=/tmp/tc-ab/shots-r2
node tools/pair-deck.mjs \
  --ours=/tmp/tc-ab/shots-r2 \
  --refs=reference/rome2-steam \
  --pairs=tools/ab-pairs-round2.json \
  --out=/tmp/tc-ab/round-2 \
  --key=/tmp/tc-ab/keys/round-2.json \
  --seed=91
```

### The leak that is the best story: IDAT length

**Sorting the deck by PNG IDAT chunk length identified our frame in 11 of 14 pairs — a 78.6%
attack with no pixel decoded.** Compressed length is a measure of how much pixel-scale detail a
picture carries, which is exactly what differs between a renderer and its target, and the
whole-file pad does not touch it because a parser adds up `IDAT` separately.

`blind-compare.mjs` argues, correctly, that the JPEG equivalent cannot be closed: the only
lever there is spending fewer bits on one side, which manufactures the very artefact the
grader is then asked to judge. **PNG is not JPEG.** It is lossless, so compressing *less* costs
nothing but bytes:

```js
const png = await sharp(jpeg).png({ compressionLevel: 0, palette: false }).toBuffer();
```

At level 0 the deflate stream is stored blocks and its length is a pure function of width and
height — 3,457,311 bytes for every 1440×800 frame in the deck, ours and theirs, byte for byte.
The leak is not reduced, it is gone, and no image is degraded by a single bit. The cost is
disk: ~3.5 MB a frame instead of ~2.4 MB. `idatBytes` accordingly moved out of the "open"
class and is now an exact-equality field. (`palette: false` is also load-bearing: left alone,
sharp quantises to 256 colours, and two images quantised independently lose different amounts
depending on how much colour variety they carried.)

Whole-file length is then equalised a second time by padding every file to one common length
with a `paDd` ancillary private chunk before `IEND` — filled with deterministic random bytes
rather than zeros, because a run of `0x00` announces itself as padding. The audit prints
`(N distinct sizes — LEAK)` if that ever fails to hold. This defeats a size *sort*, not a
determined adversary with a chunk parser, and the file says so.

### The leak the audit actually caught in the field

**The first deck this tool ever produced shipped a legible `TOTAL WAR / ROME II` wordmark** in
the bottom right of the Rome II side of the wall pair.

The cause is the interesting part. `blind-compare.mjs` clears the lockups by cutting the bottom
20% of every frame, on a rule measured across ten plates as *"nothing intrudes above 80% of
frame height"*. **That rule is false on the wider set.** The three 2.35:1 cinematic plates place
their lockup relative to the *letterboxed picture* rather than to the file, so on `s2-17` the
top of "TOTAL WAR" sits at y≈803 — 74% of frame height — inside the row window that plate gets.
An inherited constant, correct on the sample it was measured on, wrong on the population it was
then applied to.

The fix is a second defence on the *other* axis: every lockup in all twenty-two plates sits hard
against the right edge, so `MAX_W` windows the frame to 1440 px of its 1920. And the file is
emphatic that neither axis alone is sufficient, because the next person to widen one will assume
the other is carrying it:

- `s2-17` puts "TOTAL WAR" at y≈803, inside its row window. Only the 1440 crop excludes it —
  leftmost glyph x≈1535.
- `s2-04` ("THE BATTLE OF PYDNA") reaches **x≈1427, left of 1440**. Only the height window
  excludes it — that title sits at y≈1010–1050.

> The invariant is therefore the conjunction: *no lockup element is both left of `MAX_W` and
> above the height cut.*

A proof sheet of the discarded region is written beside the key on every run, so the next round
re-measures instead of inheriting — *"which is exactly what inheriting the 'bottom 20%' rule
cost."*

### Everything else the audit closes

| Channel | How it is closed |
|---|---|
| File size | Padded to one common length with a `paDd` chunk; `bytes` is an exact-equality field within a pair |
| IDAT length | `compressionLevel: 0` makes it a function of dimensions only |
| Resolution and aspect | One crop rectangle per pair, applied to **both** members, with **no resample at all**. Pairs differ from each other in size, which carries no signal because both members share it |
| Bit depth, channels, colour space | Exact equality within a pair |
| ICC profile | `withMetadata` is deliberately *not* called — calling it would re-attach ICC and density. Presence is a pair-level failure |
| EXIF / XMP | Same; `hasExif` on either member fails the pair |
| Letterboxing | `flatBorderPx` on the output, and `blackBars` on the *source* so a 2.35:1 plate can be windowed before it ever reaches a deck |
| UI chrome | The overlay audit: pixels simultaneously *static* across a pool and *structured*, minus every other origin's. Scene content fails the first test, sky and haze fail the second, a DOM interface passes both. Refused at 0.02% of frame |
| Filenames | `NN-A` / `NN-B` with the side randomised per pair from a seeded Mulberry32 stream; side balance outside 25–75% forces a reseed |
| Timestamps | Every file `utimes`'d to one stamp, `2026-01-01T00:00:00Z`, because files are written pair by pair and A was always a few ms older than its B |
| Unexpected chunks | Only `IHDR`, `IDAT`, `IEND`, `paDd` are allowed; anything else fails the build. sharp writes `pHYs` on every PNG and it is stripped |
| JPEG generation asymmetry | The plates arrive with a generation already baked in and our renders have none, so both sides go through *one identical* mozjpeg generation before being written as PNG. This does not equalise it — theirs has two, ours one — and the asymmetry is **stated in the audit rather than hidden** |
| Provenance | No `report.json`, or one saying `hud` is anything but `false`, and the build refuses at exit 3 |

All crop offsets and sizes are multiples of 16. Not tidiness: the plates already carry a JPEG
quantisation grid, and an unaligned crop would grind a second, misaligned block grid into the
reference side only.

The separability gate scores each header field by **balanced accuracy at the best single
threshold** — a constant statistic scores 0.5, a perfect tell scores 1.0 — and refuses at 0.95.
Alongside it, `pictureStats` returns **eight** numbers per frame — `lum`, `p01`, `p99`,
`chroma`, `hueSpread`, `edge`, `halo`, `vignette` — which are **reported and never refused**.
(Its header used to open "Six picture statistics" and then list eight. The count now comes from
`PICTURE_STAT_KEYS`, which the function asserts its own return against, so prose and code
cannot disagree again.)
Those are not leak detectors; they are the objective half of a round's findings, so that "the
colour is all in one narrow warm band" becomes a number the next round can be measured against.
`halo` — mean |Laplacian| over mean |gradient| — exists because press material is routinely
sharpened on its way out of a publisher and a raw framebuffer grab never is; it is reported
rather than refused because *"sharpening ours to match would be forging the answer."*

### The known limitation, which invalidated two rounds

**A 14-pair deck drawn from a single engine is one trial, not fourteen.**

Our renderer has one signature — one grass, one helmet, one sky model, one tone curve. A grader
who cracks any single pair gets the rest on palette alone. The consequence is that accuracy
reads **100% until it reads 50%, with no usable range in between**, so the instrument has no
resolving power precisely in the region where progress happens.

Round one of the paired instrument **came back 14/14 for each of three independent graders —
42/42** — and `tools/shoot.mjs` records that all three raised the same two methodological
faults about the *deck* rather than about the renderer. A second round was built to answer them
(`tools/ab-pairs-round2.json`, `--set=ab2`, also 14 pairs) and it also came back **42/42**,
with all three graders returning identical picks and 41 of the 42 calls at confidence 5.

**Both rounds are now recorded in `tools/ab-results.json`**, beside the manifests that produced
them, and that file is the citable source — this was previously true of round one only, and two
documentation volumes correctly refused to cite round two because its numbers were nowhere in
the tree. Note the denominator: a round is 3 graders × 14 pairs = 42 calls, so the two rounds
together are **84/84**, not 42/42. The record file says so in its own header, because the
handover that supplied it did not.

**Round two is the demonstration of the limitation, not an exception to it.** It measurably
closed six of the eight `pictureStats` fields — the `edge` gap by 82%, `halo` by 46% — and the
score did not move by one call. Two of its fixes were confirmed *blind*, by a grader told
nothing about them: aerial perspective, and cloth. That is the useful output of a saturated
instrument: the statistics have resolving power and the score does not.

One detail of the round-two report was checkable without the frames and was checked: the deck
was built at seed 173, and replaying `pair-deck.mjs`'s seeded Mulberry32 over
`ab-pairs-round2.json` — a 13-draw Fisher–Yates, then one draw per pair — puts ours on side A
in exactly **7 of 14**, sequence `BABABBBAABBAAA`. Seeds 91, 1 and 7 give 8, 11 and 9.

**The protocol fix is a proposal, not a practice.** One pair per grader in a fresh context is
recorded in `tools/ab-results.json` under `proposal_not_implemented`, with its open questions.
Nothing implements it.

The same structural fault is written down for the pooled deck, where it was found first:

> Every graded frame this project has ever produced came off one map, at one hour, in one
> season, at one quality tier. That is not ten trials, it is one trial photographed ten times,
> and it inflates a grader's apparent accuracy: identify two or three of ours and the rest fall
> by family resemblance.

`--set=deck` answers that on the *shot* side — ten frames, no two sharing a follow target, six
on Campus Martius and four at Pydna, hours 07:30 to 16:24, one frame at `high` rather than
ultra — and `docs/HANDOFF.md` records the honest consequence: **"no round before this one was
ten independent trials."**

**The fix on the grading side is one pair per grader in a fresh context.** Fourteen pairs shown
to one grader are one trial with thirteen confirmations; fourteen graders shown one pair each
are fourteen trials. Nothing in the tooling implements this today — it is a protocol change,
not a code change, and `pair-deck.mjs` already emits the pairs separately enough to support it.

### Round three, as built and frozen

| | |
|---|---|
| deck | `/tmp/tc-r3/deck` — the flat form, `NN-A.png` / `NN-B.png` |
| isolated | `/tmp/tc-r3/graded/pair-<token>/` — 14 directories, `A.png`, `B.png`, `README.md` |
| key | `/tmp/tc-r3/keys/round-3.json`, outside both, with the token-to-pair roster |
| shots | `tools/shoot.mjs --set=ab3 --out=/tmp/tc-r3/shots`, `hud false`, `worldOverlay hidden`, dpr 1, 1920×1080 |
| renderer | `srcTree d5a0525e7a42`, i.e. `git rev-parse HEAD:src` — not the commit, which moves when a doc does |
| seed | 307. Side balance: ours is A in 5 of 14 |
| window | 1440×720, one rectangle per pair applied to both members, no resample |
| audits | every separability field at 0.500, overlay 0.0000 % on both origins, one distinct file size |

The eight picture statistics, reported and never refused. **These are the round's objective
findings, not leak detectors**, and the deck is accepted with all of them in it:

| field | ours | Rome II | balanced accuracy at the best single threshold |
|---|---|---|---|
| `lum` | 0.4285 | 0.3549 | **0.786** |
| `p99` | 0.8979 | 0.8189 | 0.750 |
| `p01` | 0.0397 | 0.0606 | 0.714 |
| `chroma` | 0.2908 | 0.3332 | 0.714 |
| `hueSpread` | 29.22° | 42.10° | 0.714 |
| `halo` | 1.0681 | 0.9880 | 0.714 |
| `vignette` | 0.9533 | 1.1842 | 0.679 |
| `edge` | 0.0831 | 0.0847 | **0.607** |

Two things to read off that table.

**`edge` is essentially closed at 0.607**, which is round two's work holding — it was the
82 %-closed statistic and it is now the weakest separator of the eight.

**`lum` is the strongest, and round three did not cause it.** Our frames are 21 % brighter in
mean luminance than the plates. Re-shooting two frames on the source at `3f4c203` and
differencing puts this pass's contribution at **+0.0058 on the close infantry frame and
+0.0006 on the wide one** — 1.5 % and 0.1 % of the 21 % gap. The wrap terms are exactly
Lambert at `N·L = 1` by construction and only add below the terminator, which is why. The gap
is an exposure and grade question and it is the clearest target the next round has.

Two related protocol notes, both learned the hard way:

- **A grader spawned inside this repo is never fully cold.** An adversarial grader disclosed
  that it had read repository context; its calls have to be discounted accordingly.
- **Do not grade a deck until its author declares it frozen.** Three graders were sent at a deck
  that looked complete and the builder tore it down minutes later on finding the wordmark leak.
  All three refused to fabricate picks, which is the behaviour to select for — *"a grader that
  feels obliged to find a difference will invent one."*

### Never publish the reference material

`reference/` and `reference-crops/` hold copyrighted Rome II press plates and licensed museum
photographs. Both are gitignored, and the `.gitignore` comment explains that the crops are
covered *"because crops CUT FROM `reference/` are still the same copyrighted press material,
just smaller"*. `screenshots/**/*.png` and four other raster extensions are ignored for the
same reason, after a review agent writing JPEG comparison plates into `screenshots/` put frames
derived from copyrighted press material onto a committable path.

Nothing from either directory is ever copied into a deployment or into `docs/`. The
documentation site's build enforces this as a build-time refusal rather than a convention —
see `docs/site/build.mjs`, `assertNoReferenceImagery`.

---

## Adding a check

1. **Decide gate or instrument.** A pass/fail answer with a tolerance goes in a `qa-*` harness.
   A number you want to look at over time goes in a `probe-*`. Do not add a threshold to a probe
   to make it a gate; add it to the gate.
2. **Pick an unused port** and default it in the argument map. `grep -h "args.get('port')"
   tools/*.mjs` shows what is taken. Never 5173.
3. **Copy the boot preamble** from a neighbouring tool — `waitForServer`, the `chromium.launch`
   args, `TC_NO_HMR`, and `waitForFunction(fn, null, { timeout: 180000 })` with `null` in the
   arg position.
4. **Drive the product.** Fire real events at real coordinates. If your check would still pass
   with the UI element removed, it is not checking the feature.
5. **Grade against a second source where you can.** The wall arm grades against
   `CitySystem.getGarrisonBays()`; `qa-wallattack` grades picking against an independent ray
   march. Grading a function against itself is how a silent no-op ships.
6. **Make the failure line say what was observed**, not that an assertion failed. Every
   `record()` in this repo takes a `changed` string for exactly this, and it is the only part of
   the output anyone reads when something breaks.
7. **Run it twice and make one of the runs a control** that should fail. An arm that passes on
   code you have deliberately broken has not run.

## Debugging a failing check

Work down this list; it is ordered by how often each has been the answer.

1. **Is the number the right shape?** Exact zero, exact 0.0000, a value its neighbour
   contradicts, a suspiciously round figure. Four documented silent no-ops were caught here
   before anything else was investigated.
2. **Did the probe reach the thing?** A failure with *zero* page errors and *zero* console
   errors is the signature of a harness that never got there. Check `?menu=0`, check
   `window.__game` is defined at all, check `ready`.
3. **Is a function being read as a property?** `simTime` is `simTime()`. A property read returns
   a truthy function object that never changes.
4. **Is the timeout real?** `waitForFunction(fn, { timeout: N })` is a 30 s wait wearing a
   costume. Nineteen call sites still have this form — see the list above.
5. **Is the control pinned to `main`?** Not to the merge-base. Those give different answers and
   only one of them is the question you asked.
6. **Is the harness measuring the published record or the thing?** `getOutworks()` answers
   empty while the palisade still stands. Cast against the geometry.
7. **Is the input reproducible?** A drag is not: the browser coalesces `pointermove`. Use a
   click where the gesture is a nuisance parameter rather than the measurement.
8. **Is it the machine?** Seven agents on one box makes a real boot take minutes. That is what
   the 120–300 s timeouts are for, and why the 30 s default looked like a dead app.

---

## Related

- [Simulation](SIMULATION.md) — what the determinism gates are gating, and the enum these
  harnesses hardcode.
- [Architecture](../ARCHITECTURE.md) — the systems these tools drive.
- [Visual rubric](../VISUAL-RUBRIC.md) — the criteria a frame is graded against.
- [Releasing](../RELEASING.md) — the deploy gate, and verification by bundle hash.
- [Handoff log](../HANDOFF.md) — the running record; most of the incidents above are written up
  there at length.
