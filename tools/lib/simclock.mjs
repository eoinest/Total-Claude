/**
 * Stop the simulation clock before it can start, and then check that it did.
 *
 * ## The defect, which every harness in this repository has
 *
 * `src/main.ts` calls `engine.start()` at the end of `boot()` and *then* sets
 * `window.__game.ready = true`. Every driver here waits for that flag and **then** does
 * `page.evaluate(() => window.__game.engine.stop())` — which is a round trip through the
 * automation protocol. On a loaded machine that is tens or hundreds of milliseconds during which
 * the rAF loop is running, and **every frame carries fixed steps**. So two runs of the same build
 * begin their measurement at different tick counts, and a checkpoint labelled t+0 is t+0.0 in one
 * and t+0.1 in whichever was unluckiest.
 *
 * The window is proportional to load, which is why it hides on a quiet box and appears on a busy
 * one. Measured: on a machine running nine agents, `tools/qa-xengine.mjs` reported the Carthage
 * assault **diverging in Firefox at t+0 with a different `uctl`** — a *control-flow* difference
 * before a tick was supposed to have run. No rounding difference can take that shape, which is
 * the only reason it was investigated rather than published as a finding.
 *
 * ## Printing a diagnostic is not checking it
 *
 * `tools/qa-determinism.mjs` has named "the t+0 rAF race" in its own header since it was written,
 * prints `simTime` on every single line it emits, and never compared it. The number that would
 * have caught the bug was displayed next to the bug for as long as the bug existed. That is the
 * whole lesson and it is why this module exports two things rather than one: the prevention, and
 * the check that the prevention worked. **A prevention you have not verified is a hope.**
 *
 * ## Why the hook is on the flag and not on the clock
 *
 * The obvious fix is to stub `requestAnimationFrame` in an init script so no frame ever runs.
 * **It hangs the boot** — something on that path needs a frame — and the next person to read this
 * will try it, so it is written down. Intercepting the `ready` assignment instead makes the stop
 * happen synchronously in the same microtask as the start, which is early enough and safe.
 *
 * ## Usage
 *
 *     import { stopClockOnReady, simTimeFault } from './lib/simclock.mjs';
 *
 *     await stopClockOnReady(page);            // BEFORE page.goto — addInitScript, not evaluate
 *     await page.goto(url, ...);
 *     await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
 *     await page.evaluate(() => window.__game.engine.stop());   // belt as well as braces
 *
 * and then, wherever a checkpoint is recorded, carry `simTime` as a **compared mark** and refuse
 * the run if `simTimeFault` returns a message.
 *
 * `bootThroughMenu` in `./menu-boot.mjs` takes `stopClock: true` for the same thing. It is
 * **opt-in there and off by default**, because that function's other callers are the playability
 * rigs, which drive a battle in real time and need the clock they were given. The rule: *if your
 * tool hashes anything at a fixed checkpoint, pass it; if your tool watches a battle happen, do
 * not.*
 *
 * ## Who has this fix and who does not, as of 22 August 2026
 *
 * Converted, and the rule for the list is *every tool that compares two runs at a fixed
 * checkpoint*:
 *
 *   - `tools/qa-determinism.mjs` — A vs B, **and the cross-tier arm**, which compares four page
 *     loads and is four more chances for this race to make an agreement meaningless.
 *   - `tools/qa-xengine.mjs` — three engines plus a second load of the reference.
 *   - `tools/qa-replay.mjs`, on the **`playback` side only**. Its `recordBattle` deliberately
 *     drives a real mouse through a real battle in real time and records whatever tick count
 *     that reaches; stopping its clock would be stopping the thing it is recording. `playback`
 *     already compensated for the tick *count* (`target - done` reads the real tick), which is
 *     why it has been green — and the count was never the whole hazard, because those ticks run
 *     before `tickCeiling` is pinned and can pump the recorded deployment operations at a tick
 *     number that varies with the load average.
 *   - `bootThroughMenu` in `./menu-boot.mjs`, on request.
 *
 * **Still exposed**, and named rather than left to be rediscovered: the `tools/judge/` rig
 * (whose `boot()` waits 1,500 ms of wall clock after `ready` with autoplay on, which is this race
 * with a window three orders of magnitude wider), `probe-fabric`, `probe-plan`, `probe-tiber`,
 * `probe-seams`, `probe-ground`, `probe-wall`, and the `pl-*` and `jg-*` playability rigs.
 * Whether it matters depends on whether the tool compares two runs of anything: a probe that
 * measures one geometry once does not care, and a probe that asserts two runs agree cares a great
 * deal.
 */

/**
 * Install the interception. Must be called before `page.goto`: `addInitScript` runs before the
 * page's own scripts, which is the only place early enough to see the assignment.
 */
export const stopClockOnReady = (page) => page.addInitScript(() => {
  let game;
  Object.defineProperty(window, '__game', {
    configurable: true,
    get() { return game; },
    set(v) {
      game = v;
      let ready = false;
      Object.defineProperty(v, 'ready', {
        configurable: true,
        get() { return ready; },
        set(r) {
          ready = r;
          // `engine.start()` has just run, in this same microtask. Nothing has drawn yet.
          if (r) { try { v.engine.stop(); } catch { /* nothing to stop yet */ } }
        },
      });
    },
  });
});

/** One fixed step, in simulated seconds. */
export const FIXED_DT = 1 / 30;

/**
 * Slack on the *ahead* side only, and it is a floating-point epsilon rather than a tolerance.
 *
 * `advance(secs, stepMs)` runs whole fixed steps, so a checkpoint can land up to one step
 * **short** of the second it names and never past it. Measured on the field battle at
 * `1000/60`: t+0, t+30, t+90, t+150 and t+400 land exactly, and t+200 and t+250 land one tick
 * short — 199.967 and 249.967 — reproducibly, in every run and in every engine.
 */
const EPS = 1e-9;

/**
 * Is a set of runs comparable at this checkpoint?
 *
 * `times` is one simulated-time reading per run; `expected` is the checkpoint it claims to be.
 * Returns `null` when the runs are comparable, or a printable reason when they are not.
 *
 * Two conditions, and they catch different things.
 *
 * **Every run is at the same simulated time**, by exact equality rather than a tolerance. The
 * quantity being compared downstream is exact bits, so anything that makes two runs differ at
 * all makes the comparison meaningless. A tolerance here would need an epsilon and every epsilon
 * would be invented.
 *
 * **And that time is not *past* the checkpoint it claims.** This was `Math.abs(drift) <
 * FIXED_DT` and that was symmetric, which is wrong in both directions at once. `advance()` runs
 * whole fixed steps, so landing up to one step short is not a fault — it is the only thing that
 * can happen, and it happens at four of this project's seven checkpoints. Meanwhile the failure
 * this module exists for puts *extra* ticks in at boot, so the interesting side is the one the
 * symmetric form treated as slack. Worse, at exactly one tick short the symmetric form sat on
 * its own boundary: 200 − 199.96666… is `FIXED_DT` to the last bit, and the check passed only
 * because the caller had rounded `simTime` to three decimals first. An assertion that holds by
 * decimal-rounding luck is not an assertion.
 *
 * So: never ahead, and at most one whole tick behind.
 */
export const simTimeFault = (times, expected, labels = null) => {
  const same = times.every((t) => t === times[0]);
  const drift = times[0] - expected;
  const onSchedule = drift <= EPS && drift > -(FIXED_DT + EPS);
  if (same && onSchedule) return null;
  const shown = labels
    ? times.map((t, i) => `${labels[i]} ${t}`).join('  ')
    : times.join(', ');
  return `t+${expected}: ${shown}`
    + (same
      ? `  — every run agrees, and all of them are ${drift > 0 ? 'PAST' : 'short of'}`
        + ` the checkpoint they claim by ${Math.abs(drift).toFixed(4)} s`
        + (drift > 0 ? ' (ticks ran before the clock was stopped)' : ` (> one tick, ${FIXED_DT.toFixed(4)} s)`)
      : '  — the runs are at different points in the battle');
};
