#!/usr/bin/env node
/**
 * QA: determinism at the current scale.
 *
 * Two independent page loads, advanced by an identical schedule, must produce a
 * bit-identical soldier pool. The claim in README.md ("a battle replays identically —
 * verified by hashing every soldier's state across independent runs") was last checked at
 * 2,544 men; this runs it at ~8,970.
 *
 * Hashes x/z/state/hp per soldier at several checkpoints. On divergence it reports the
 * first differing soldier index and the field that differs, which is what actually
 * localises the culprit.
 *
 * Usage: node tools/qa-determinism.mjs [--port=5226] [--at=0,30,90,150,200,250,400]
 *                                       [--json=path] [--render] [--record]
 *                                       [--battle=map=carthage&scenario=assault]
 *                                       [--soft-units] [--tiers=off] [--tier-at=0,30,90]
 *
 * `--battle` appends extra query parameters, so the gate can be run against a battle other
 * than the default one. It matters now that there are two besiegeable cities: an assault
 * takes an entirely different code path through `deployAssault` and `Siege`, and a garrison
 * pinned to a wall-walk is the part of the sim least like the field battle this gate has
 * always measured.
 *
 * **Check that a new checkpoint measures the battle you think it does.** `--battle` is the
 * flag, and a *misspelled flag* is still silently ignored — `--batle=…` runs the field battle
 * and says nothing. The tell is the headcount: 8,632 for `default`, 3,074 for Rome's assault,
 * 3,440 for Carthage's. That is printed on every line for exactly this reason.
 *
 * `--battle` itself is now validated rather than merely documented: every segment must be
 * `key=value` and every key must be one `src/` reads, so `--battle=rome` exits 2 with the three
 * real invocations printed instead of quietly measuring the field battle under Rome's name.
 * The three arms, and the shell quoting is not optional:
 *
 *     node tools/qa-determinism.mjs
 *     node tools/qa-determinism.mjs --battle='map=campus-martius&scenario=assault'
 *     node tools/qa-determinism.mjs --battle='map=carthage&scenario=assault'
 *
 * ## Three arms per invocation
 *
 *   **A vs B** — two loads of this build. Does this battle replay? Exact bits, hard failure.
 *   **cross-tier** — the same battle at `low`, `medium`, `high` and `ultra`. Does a graphics
 *     setting change the battle? Exact bits, hard failure. See the block that runs it for why
 *     it cannot pass vacuously; `--tiers=off` skips it and says so out loud.
 *   **baseline** — run A against `tools/determinism-baseline.json`. Is this the same battle as
 *     yesterday? All three of `hash`, `uctl` and `uf64` hard, unless `--soft-units`.
 *
 * **And check that it measures the tree you think it does.** This file used to reuse any
 * listener that answered on `--port`, which in a checkout with eighty worktrees on a handful of
 * default ports means it could measure another agent's branch against this tree's baseline and
 * report the verdict with complete confidence. `startVite` below asks the listener which
 * worktree it is serving (`/__tc/tree`) and refuses a foreign one. `--port=59xx` to own your
 * own; `node tools/browsers.mjs` says who holds what.
 *
 * ## Why the checkpoints run to t+400 and not to t+200
 *
 * They used to stop at t+200, and the horizon was luck rather than design. Chromium, Firefox
 * and WebKit run the default field battle bit-identically through every checkpoint that was
 * pinned — t+0, 30, 90, 150, 200 — and fork at **t+205.5 s**, five and a half seconds past the
 * end of the gate, never to re-converge: by t+600 one engine had 2,766 men standing and
 * another had 4,281. Three separate passes ran three engines against this battle, reported
 * IDENTICAL, and were all correct, because all three stopped where this file stopped. A gate
 * that ends 5.5 s before the only divergence anyone has ever measured is not a gate.
 *
 * So there are two more checkpoints, and they are chosen rather than inherited:
 *
 *   **t+250** — the sentinel. 44.5 s past the fork, which is a wide margin on a divergence
 *   the transport pass measured as a step function rather than a slope (2 pm apart at t+205,
 *   6.5 m and 516 men displaced at t+210). It costs about 9 s of wall clock per page load on
 *   the field battle. This is the cheapest checkpoint in the file per unit of new coverage
 *   and it is the one that exists because of the finding.
 *
 *   **t+400** — the second half. t+200 leaves 6,623 of 8,632 men alive on the field and 2,833
 *   of 3,440 in Carthage; the battles run on for another five minutes with the outcome still
 *   moving. Everything a change does after the two-minute mark was invisible. This is the
 *   expensive one: about 35 s per load on the field battle.
 *
 * And the ceiling is t+400 rather than t+600 on purpose. Measured here at `66b220b`, per page
 * load with `{ render: false }`, the field battle costs 34.6 s to reach t+200, 17.9 s more to
 * reach t+300, 17.4 s more to t+400, then 15.4 s, 15.0 s and 14.2 s for each further hundred.
 * Two loads per invocation, three battles in the full gate. Going to t+600 would add roughly
 * 60 s per battle per invocation and buy almost nothing: divergence detection is binary on a
 * hash, and any post-fork checkpoint sees the fork. t+250 detects it, t+400 detects it, t+600
 * detects it no harder — it only measures the amplitude, and the amplitude is not what a gate
 * is for. Nobody runs a gate they have decided is too slow, and that failure mode has already
 * cost this project one year of not seeing t+205.5.
 *
 * ## Two hashes, because the pool hash cannot see the simulation's own state
 *
 * `SoldierPool` is typed arrays: every tick reads float32, computes in float64, writes back
 * to float32. That round trip is a quantisation firewall — a 1-ULP double disagreement
 * (2.2e-16 relative) survives the write to float32 (quantum 1.19e-7) only about 2e-9 of the
 * time — and it is the entire reason three browser engines agree bit-for-bit for 6,000 ticks.
 * The pool hash measures the far side of that firewall.
 *
 * `UnitGroupState` (`src/sim/types.ts`) is on the near side. `x, z, facing, targetX, targetZ,
 * targetFacing, morale, fatigue, ammo, chargeTimer, routTimer` are plain float64, integrated
 * in place, with no quantisation step anywhere — and until now nothing in this repository
 * hashed them. Measured drift between two engines over 35 units × 11 fields: 3 of 385 fields
 * differ by tick 30, 51 by tick 600, 168 by tick 6,000, the worst by 16,974 ULP. The
 * simulation's own state is engine-dependent from t+1 s. Only its float32 projection is not,
 * and the projection was the only thing anyone checked.
 *
 * So each checkpoint now carries three marks, at deliberately different strictness:
 *
 *   `hash`  — FNV over the float32 pool, x/z/state/hp. Unchanged, still pinned, still the
 *             thing fifteen recorded hashes are keyed to. Hard failure either way.
 *
 *   `uf64`  — the **exact float64 bits** of every continuous `UnitGroupState` field, plus the
 *             waypoint queue. Exact bits, not a tolerance: a tolerance needs an epsilon, every
 *             epsilon here would be a made-up number, and the measured drift reaches 16,974
 *             ULP by tick 6,000 anyway, so an epsilon would only delay the report rather than
 *             stabilise it. Brittle on purpose. A vs B — same build, same engine, same machine
 *             — must match it exactly and it is a hard failure if they do not. Against the
 *             recorded baseline it is a **warning**, because a different Chromium build will
 *             move it through no fault of the tree: this is the portability signal, and
 *             portability is not what an every-commit gate can afford to fail on. `--strict-units`
 *             promotes it to a failure for anyone deliberately testing portability.
 *
 *             **Amended 21 August 2026.** That reasoning was correct about an *unquantised*
 *             float64 layer and `src/sim/quantise.ts` quantised it. Three browser engines now
 *             agree on `uf64` for six thousand ticks, so it is hard-failing by default like the
 *             other two marks, and `--soft-units` is the escape rather than `--strict-units`
 *             being the promotion. See the flag's own comment below.
 *
 *   `uctl`  — the discrete half of `UnitGroupState`: order, target, formation, width, alive,
 *             kills, membership, and the flags. This is what the battle *decided*, and it is
 *             robust to exactly the thing `uf64` is brittle to — a 1-ULP libm difference
 *             injected at the true measured magnitude moved the pool hash at frame 3,519 and
 *             produced no control-flow difference at all in 6,000 frames. So `uctl` is
 *             pinned and hard-failing, like the pool hash. A `uctl` drift is a real change in
 *             the battle; a `uf64`-only drift may be nothing but a browser update.
 *
 * `selected` is excluded from both: it is UI state, written by `SelectionController` outside
 * any fixed step, and hashing it would make a mouse click look like a desync.
 *
 * ## The gate does not draw, and that is proved rather than assumed
 *
 * This is a hash comparison. It never looks at a pixel. But `Engine.advance` rasterised every
 * synthetic frame, so the Rome arm alone submitted **24,000 frames at 8,632 men** — two runs,
 * 200 s of battle, sixty frames per simulated second — and the gate that every agent is asked
 * to run on every change took tens of minutes on a shared box. It was the single most
 * expensive thing in the workflow and none of it reached the result.
 *
 * `{ render: false }` skips the submit and nothing else: every `fixedUpdate`, `update` and
 * `preRender` still runs, in order, with the same arguments. Measured before it was adopted
 * here — three independent loads of the Carthage assault advanced by one schedule — the
 * rendered and unrendered arms agree on every bit at t+0/30/90/150/200:
 * `ebf383b0 d021b848 8106e2b2 b4fc645e cbfa61c0`. `--render` restores the old behaviour if a
 * future change to the frame ever makes that worth re-testing.
 *
 * **Do not "speed it up" further by coarsening the step.** `advance(dt, 166)` and an
 * exactly-five-tick `advance(dt, 1000/6)` both produce *different* hashes from
 * `advance(dt, 1000/60)`. Equal tick counts are not sufficient; how many ticks share a frame
 * reaches the simulation. Several siege probes use the 166 ms idiom and are therefore not
 * fast-forwarding the battle this file measures.
 *
 * **Annotated 21 August 2026 — the advice is right and its stated reason is wrong.** This file
 * drives by *seconds*, and a coarser step at the same elapsed time runs a different number of
 * ticks: 900 at 1000/60, 901 at 166 ms, 899 at an exactly-five-tick 1000/6, because
 * `double(1/6)` is about 7e-18 short of five times `double(1/30)` so the fifth subtraction
 * fails once and `maxStepsPerFrame = 5` means the tick is never made up. So do not coarsen
 * this file's step — but not because frame grouping reaches the simulation. Held to an equal
 * *tick count*, five ticks a frame and one tick every two frames are bit-identical on all
 * three hashes across a 6,783-tick battle with real player orders in it
 * (`tools/qa-replay.mjs`, which uses `window.__game.advanceTicks`).
 *
 * ## A build compared with itself cannot see a build that changed
 *
 * Everything above compares run A with run B of the *same* tree, so it answers "does this
 * battle replay" and is structurally incapable of answering "is this the same battle as
 * yesterday". Both determinism arms have this shape — `qa-deploy.mjs`'s Arm 4 as well — and
 * both were green through the whole of the regression that prompted this: `89e7a44` moved
 * Rome's assault so that the ram lands 24 blows instead of 26 and the Porta Flaminia never
 * opens, and nothing said a word. The hash that would have caught it was already being
 * computed and printed on every run, and then thrown away.
 *
 * So the marks of run A are also compared against `tools/determinism-baseline.json`, keyed by
 * battle. Measured across that boundary, with `--at=0,30`:
 *
 *   map=campus-martius&scenario=assault   3ff6d41 (good)   89e7a44 (bad)
 *     t+0                                 113cd9f0         22bb3df8
 *     t+30                                308ccb88         cbd1213e   alive 3010 -> 2990
 *
 * The **t+0** hash moves, which is the cheapest detection there is: the clip deletes 22
 * garrison stations, so the armies differ before a tick has run and the gate fails in the
 * time it takes to load two pages.
 *
 * A drift is not by itself a defect — a deliberate balance change moves it too, and
 * `64dfb88` moved it on purpose and said so. The point of the file is that moving it now
 * costs one line of `--record` and a sentence in a commit message, instead of costing nobody
 * anything and being found six weeks later by an agent counting blows. **Re-record only in
 * the same commit as the change that moved it, and say why in the message.**
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from './lib/browser-budget.mjs';
import { simTimeFault, stopClockOnReady } from './lib/simclock.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5226);
const JSON_OUT = args.get('json') ?? null;
const CHECKPOINTS = (args.get('at') ?? '0,30,90,150,200,250,400').split(',').map(Number);
const EXTRA = args.get('battle') ? `&${args.get('battle')}` : '';
/** Rasterise the fast-forward. Off by default; see the note at the top of this file. */
const RENDER = args.get('render') === 'true';
/** Overwrite this battle's entry in the baseline instead of asserting against it. */
const RECORD = args.get('record') === 'true';
/**
 * Whether a float64 unit-layer drift against the *baseline* is a failure or a warning.
 *
 * **This defaulted to a warning for a measured reason, and that reason has expired.** `uf64`
 * was exact-bit over a layer with no quantisation step anywhere, so one libm call rounding
 * differently moved it within a second of simulated time and a Chromium point release moved it
 * with no change to this tree at all. Defaulting it to a failure would have redded the gate for
 * every agent every time a browser updated. So it was a warning, and `--strict-units` promoted
 * it for anyone deliberately testing portability.
 *
 * `src/sim/quantise.ts` closed that. The unit layer is now snapped to float32 at birth and at
 * the end of every tick — the same firewall the soldier pool has always had — and the
 * consequence, measured with `tools/qa-xengine.mjs` across Chromium 151, Firefox 153 and
 * WebKit 26.5: `uf64` used to differ at **t+30** on the field battle and now agrees through
 * **t+200**, and on both sieges it agrees at every one of the seven checkpoints. A mark that
 * three browser engines agree on for six thousand ticks is not a noise source. It is a gate.
 *
 * So the default is now a hard failure, like `hash` and `uctl`. `--soft-units` restores the
 * warning for whoever needs it; `--strict-units` is still accepted and is now what happens
 * anyway. **If you find yourself reaching for `--soft-units` on an unchanged tree, that is a
 * finding — the firewall has a hole in it and `qa-xengine.mjs` will tell you which field.**
 */
const SOFT_UNITS = args.get('soft-units') === 'true';
const STRICT_UNITS = !SOFT_UNITS;

// ---------------------------------------------------------------------------
// The cross-tier arm
// ---------------------------------------------------------------------------

/**
 * Every tier the game ships, **read out of `src/core/Engine.ts` rather than written here**.
 *
 * A hardcoded list is how this arm would eventually go quiet: somebody adds a fifth preset, the
 * list still says four, and the tool reports tier independence for a tier it never loaded. So
 * `QUALITY_PRESETS`' own keys are the source and a mismatch against the expected four is a hard
 * failure with an instruction rather than a silent gap. It is a lexer and it says so: it matches
 * the top-level keys of the preset object literal and nothing cleverer.
 */
const ENGINE_SRC = await readFile(path.resolve(ROOT, 'src/core/Engine.ts'), 'utf8');
const ALL_TIERS = (() => {
  const block = ENGINE_SRC.match(
    /QUALITY_PRESETS:\s*Record<QualityTier,\s*QualitySettings>\s*=\s*\{([\s\S]*?)\n\};/
  );
  if (!block) {
    console.error('could not find QUALITY_PRESETS in src/core/Engine.ts.');
    console.error('  The cross-tier arm derives its tier list from it and will not guess.');
    process.exit(2);
  }
  return [...block[1].matchAll(/^ {2}(\w+):\s*\{/gm)].map((m) => m[1]);
})();
/** The tier runs A and B use, and therefore the tier the baseline is keyed to. */
const GATE_TIER = 'high';
if (ALL_TIERS.length !== 4 || !ALL_TIERS.includes(GATE_TIER)) {
  console.error(`QUALITY_PRESETS has ${ALL_TIERS.length} tier(s) (${ALL_TIERS.join(', ')}).`);
  console.error(`  This file expected four including '${GATE_TIER}'. A tier was added or renamed:`);
  console.error('  check GATE_TIER is still the tier the baseline is recorded at, then update the');
  console.error('  count here. Failing loudly beats testing three tiers out of five in silence.');
  process.exit(2);
}
/** `--tiers=off` skips the cross-tier arm. On by default; it is the arm that owns a ruling. */
const TIER_ARM = (args.get('tiers') ?? 'on') !== 'off';
/**
 * Where the cross-tier arm compares, and why it is shorter than the main schedule by default.
 *
 * The coupling this arm exists to catch is an *input* to the battle — the tier fixed the
 * soldier pool, the pool fitted `unitSizeScale`, and the armies were different sizes before a
 * tick had run — so it is visible at **t+0**, which is the cheapest detection there is and the
 * same argument this file already makes for the assault's t+0 hash. t+30 and t+90 are there
 * because that argument only covers couplings that land at boot: a render field read from
 * inside `fixedUpdate` would leave t+0 identical and fork later, and t+90 is the first
 * checkpoint at which both assaults have men routing and machines working at a gate.
 *
 * The full schedule is one flag away (`--tier-at=0,30,90,150,200,250,400`) and costs about
 * three more field-battle page loads to t+400, which is why it is not the default: a gate
 * nobody runs measures nothing, and this file has already paid for that lesson once.
 */
const TIER_AT = (args.get('tier-at') ?? CHECKPOINTS.slice(0, 3).join(','))
  .split(',').map(Number).filter((n) => Number.isFinite(n));

/**
 * The battle, as a stable key.
 *
 * The pairs are sorted so `scenario=assault&map=carthage` and `map=carthage&scenario=assault`
 * are one entry rather than two, and the default battle is spelled `default` rather than the
 * empty string so the file reads.
 */
const BATTLE_KEY = args.get('battle')
  ? args.get('battle').split('&').map((s) => s.trim()).filter(Boolean).sort().join('&')
  : 'default';
const BASELINE_PATH = path.resolve(ROOT, 'tools/determinism-baseline.json');

/**
 * `--battle` must name a battle, and a run that does not is refused rather than run.
 *
 * `--battle=rome` was a trap for months and `docs/HANDOFF.md` and `docs/tech/TOOLING.md` both
 * documented it as one. The value is appended verbatim as query parameters *and* used as the
 * baseline key, so `rome` appends a meaningless `&rome`, loads the **default field battle**,
 * looks up a baseline key that does not exist, prints "no baseline for this battle" and exits
 * 0. It passes while asserting nothing, and the headcount is the only tell — 8,632 where the
 * reader expected 3,074.
 *
 * Documenting a trap does not close it. Two conditions close it: every segment must be
 * `key=value`, and every key must be one `src/` actually reads. `PARAM_KEYS` is the set that
 * appears in a `params.get`/`params.has` call anywhere under `src/`; a new one costs a word
 * here and the failure it prevents costs a pass. It does not catch a misspelled *flag* name,
 * which is a different hole and still open — the headcount remains the backstop for that.
 */
const PARAM_KEYS = new Set([
  'autoplay', 'battle', 'deploy', 'difficulty', 'enemy', 'from', 'h', 'harness', 'map',
  'menu', 'overlay', 'procedural', 'quality', 'replay', 'scenario', 'w',
]);
if (args.get('battle')) {
  const segs = args.get('battle').split('&').map((s) => s.trim()).filter(Boolean);
  const bad = segs.filter((s) => !s.includes('=') || !PARAM_KEYS.has(s.split('=')[0]));
  if (!segs.length || bad.length) {
    console.error(`--battle=${args.get('battle')} is not a battle.\n`);
    console.error(bad.length
      ? `  ${bad.length} segment(s) the app does not read: ${bad.join(', ')}`
      : '  empty value');
    console.error('\n  The value is appended verbatim as query parameters AND used as the');
    console.error('  baseline key, so a short name loads the default field battle and looks up');
    console.error('  a key nobody recorded. The three real invocations are:\n');
    console.error('    node tools/qa-determinism.mjs');
    console.error("    node tools/qa-determinism.mjs --battle='map=campus-martius&scenario=assault'");
    console.error("    node tools/qa-determinism.mjs --battle='map=carthage&scenario=assault'\n");
    console.error('  Quote the value or the shell backgrounds on the &. Confirm the run by');
    console.error('  headcount: field battle 8,632 / Rome 3,074 / Carthage 3,440.');
    process.exit(2);
  }
}
if (TIER_ARM) {
  const missing = TIER_AT.filter((t) => !CHECKPOINTS.includes(t));
  if (!TIER_AT.length || missing.length) {
    console.error(`--tier-at must be a non-empty subset of --at=${CHECKPOINTS.join(',')};`
      + ` ${missing.length ? `${missing.join(',')} is not in it` : 'it is empty'}.`);
    console.error('  The arm compares each tier against run A, so run A has to have a mark there.');
    process.exit(2);
  }
}

/*
 * ## The browser comes first, and it comes from the budget
 *
 * Two changes here, both from the 22 Aug 2026 incident — load average 160 on 16 cores, 136
 * concurrent `vite` and `chrome-headless-shell` processes, machine down.
 *
 * **`launchBrowser` instead of `chromium.launch`.** Every agent runs this in its own worktree
 * and this file had no idea any other copy of it existed. It now takes one of a small number
 * of machine-wide slots (`tools/lib/browser-budget.mjs`) and queues, loudly, if they are all
 * taken. `node tools/browsers.mjs` says who has them.
 *
 * **The browser is acquired before the server is started**, which is the reverse of the old
 * order and is deliberate: a run that is going to spend ten minutes in the queue should not
 * spend them holding a Vite server open on a port nobody else can use.
 *
 * **`startVite` instead of `spawn('npx', ['vite', …])`.** The handle this file used to hold was
 * npx, not Vite, so `server.kill('SIGTERM')` at the bottom signalled a wrapper two processes
 * above the server and left the real one on the port.
 *
 * And it closes a hole this file had no name for. It reused *any* listener already on 5226,
 * including one serving **a different worktree** — a determinism gate confidently measuring
 * another agent's branch, with a headcount that happens to differ as the only tell, which is
 * exactly the class of fault the `--battle` validation above exists to prevent. `startVite`
 * asks the listener which tree it is serving (`/__tc/tree`) and refuses if it is not this one.
 */
const browser = await launchBrowser({
  label: 'qa-determinism', port: PORT, root: ROOT,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const { base, close: closeServer } = await startVite({
  port: PORT, root: ROOT, label: 'qa-determinism', slot: browser.budgetSlot,
});

/**
 * The page-side readers.
 *
 * The two hashes themselves are **no longer injected here**. They live in
 * `src/sim/stateHash.ts` and are reached through `window.__game.hashes()`, so the
 * arithmetic this file pins is the arithmetic the product computes and a second consumer —
 * `tools/qa-replay.mjs` — cannot drift from it by copying forty lines slightly wrong. The
 * bit patterns are unchanged: `poolHash` still multiplies with the float `h * 0x01000193`
 * that rounds above 2^53 and is therefore not FNV, because twenty-one recorded hashes are
 * keyed to it, and `unitHash` is still the real `Math.imul` FNV-1a it was written as.
 *
 * What stays here is the *localiser*: the raw dumps this file reads when something has
 * already gone wrong, which are a harness concern and have nothing pinned to them. They
 * read their field lists off `window.__game.hashFields()` for the same reason — the thing
 * that reports a drift must never be reading a different set from the thing that found it.
 */
const HASH_FN = `
  window.__marks = () => window.__game.hashes();
  window.__poolHash = () => { const h = window.__game.hashes(); return { hash: h.hash, count: h.count, alive: h.alive }; };
  window.__unitHash = () => { const h = window.__game.hashes(); return { uf64: h.uf64, uctl: h.uctl, units: h.units }; };
  window.__UNIT_F64 = window.__game.hashFields().f64;
  window.__UNIT_CTL = window.__game.hashFields().ctl;

  window.__poolDump = () => {
    const p = window.__game.battle.pool;
    return {
      count: p.count,
      x: Array.from(p.x.subarray(0, p.count)),
      z: Array.from(p.z.subarray(0, p.count)),
      state: Array.from(p.state.subarray(0, p.count)),
      hp: Array.from(p.hp.subarray(0, p.count)),
      unitId: Array.from(p.unitId.subarray(0, p.count)),
    };
  };

  window.__unitDump = () => window.__game.battle.units.map((u) => ({
    id: u.id,
    typeId: u.typeId,
    f64: window.__UNIT_F64.map((k) => u[k]),
    ctl: window.__UNIT_CTL.map((k) => u[k]),
    waypoints: (u.waypoints ?? []).slice(),
  }));
`;

/** One independent run: fresh page, rAF stopped, advanced by the identical schedule. */
async function run(label, tier = GATE_TIER, checkpoints = CHECKPOINTS) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  /*
   * Stop the clock inside the page, on the assignment that announces readiness.
   *
   * The `page.evaluate(stop)` below is still here and is still correct, and it was never
   * sufficient. `main.ts` calls `engine.start()` at the end of `boot()` and then sets
   * `__game.ready = true`; a harness that waits for the flag and *then* evaluates a stop has a
   * driver round trip in between, and on a loaded machine that is tens or hundreds of
   * milliseconds of rAF, every frame of which carries ticks. Two runs need not lose the same
   * number, which is the "t+0 rAF race" this file's history already names — and
   * `tools/qa-xengine.mjs` caught the cross-engine version of it reporting a `uctl` difference
   * at t+0, which is a shape rounding cannot produce.
   *
   * `addInitScript` runs before the page's own scripts, so this intercepts the assignment: the
   * stop happens synchronously in the same microtask as the start, before the first frame.
   * (Blocking `requestAnimationFrame` outright hangs the boot — something on that path needs a
   * frame — so the hook is on the flag.) `simTime` is no longer merely printed below: it is
   * compared, against the other run and against the checkpoint it claims to be.
   */
  await stopClockOnReady(page);
  // 180 s, not Playwright's 30 s default: at load average 47 a cold boot exceeds it and the
  // run dies on navigation rather than on anything this file is about.
  await page.goto(`${base}/?harness=1&quality=${tier}&w=960&h=540${EXTRA}`,
    { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
  // Belt as well as braces: the hook above should already have stopped it.
  await page.evaluate(() => window.__game.engine.stop());
  await page.evaluate(HASH_FN);

  /*
   * What this page actually loaded, read off the engine rather than assumed from the URL.
   *
   * The cross-tier arm below is worthless without it: if `?quality=` were ignored — a typo in
   * the parameter name, a `sanitiseConfig` that rejected the value, a future build that reads
   * the tier from somewhere else — four "different" tiers would be four identical runs and the
   * arm would report tier independence while measuring one tier four times. So the tier is
   * read back, and so is every render field, and the arm requires the render half to *differ*
   * before it is willing to conclude anything from the simulation half matching.
   */
  const settings = await page.evaluate(() => {
    const q = window.__game.engine.quality;
    const b = window.__game.battle;
    return {
      tier: q.tier,
      render: {
        maxPixelRatio: q.maxPixelRatio, renderScale: q.renderScale,
        shadowMapSize: q.shadowMapSize, shadowCascades: q.shadowCascades,
        ssao: q.ssao, bloom: q.bloom, motionBlur: q.motionBlur,
        volumetricLight: q.volumetricLight, depthOfField: q.depthOfField,
        lodFarDistance: q.lodFarDistance, grassDensity: q.grassDensity,
        antialias: q.antialias,
      },
      // The simulation's own inputs. `maxSoldiers` is reported rather than compared: it is
      // provenance for a reader of the log, and the assertion is on the two fields below it
      // that actually reach the battle, plus the hashes.
      sim: { poolCap: b.pool.capacity, unitScale: b.unitSizeScale },
      maxSoldiers: q.maxSoldiers ?? null,
    };
  });

  const marks = [];
  let prev = 0;
  for (const at of checkpoints) {
    if (at > prev) {
      // Identical step size in both runs, so the fixed-step schedule matches exactly. The
      // third argument is ignored by any build predating it, which only makes the gate slower.
      await page.evaluate(
        ([secs, render]) => window.__game.engine.advance(secs, 1000 / 60, { render }),
        [at - prev, RENDER]
      );
      prev = at;
    }
    // One call, not two: `hashes()` computes both halves in one pass over the pool and the
    // unit array, and asking twice would double the only cost this loop has.
    const m = await page.evaluate(() => window.__marks());
    const h = { hash: m.hash, count: m.count, alive: m.alive };
    const u = { uf64: m.uf64, uctl: m.uctl, units: m.units };
    marks.push({ at, ...h, ...u, simTime: await page.evaluate(() => +window.__game.simTime().toFixed(3)) });
    console.log(`  ${label}  t+${String(at).padStart(3)}  simTime ${marks.at(-1).simTime.toFixed(3)}  ` +
      `count ${h.count}  alive ${h.alive}  hash ${h.hash}  uf64 ${u.uf64}  uctl ${u.uctl}`);
  }
  return { page, marks, errors, settings };
}

// ---------------------------------------------------------------------------
// ULP distance between two float64s, for the unit-layer localiser
// ---------------------------------------------------------------------------
/*
 * Sign-magnitude to a monotone integer key, so that the number of representable doubles
 * between two values is a subtraction. -0 and +0 both map to 0, which is what you want:
 * they are the same point on the number line and reporting them as 2^63 ULP apart would be
 * an instrument defect rather than a finding.
 */
const ULP_DV = new DataView(new ArrayBuffer(8));
const ulpKey = (v) => {
  ULP_DV.setFloat64(0, v);
  const u = ULP_DV.getBigUint64(0);
  return u & (1n << 63n) ? -(u & ((1n << 63n) - 1n)) : u;
};
const ulpGap = (a, b) => {
  if (Object.is(a, b)) return 0n;
  if (Number.isNaN(a) || Number.isNaN(b)) return -1n;         // -1 reads as "not comparable"
  const d = ulpKey(a) - ulpKey(b);
  return d < 0n ? -d : d;
};

console.log('• run A');
const A = await run('A');
console.log('• run B');
const B = await run('B');

let failed = 0;
let warned = 0;
console.log('\n--- comparison (A vs B: same build, same engine — exact match required) ---');
const diffs = [];
const unitDiffs = [];
for (let i = 0; i < CHECKPOINTS.length; i++) {
  const a = A.marks[i], b = B.marks[i];
  const poolSame = a.hash === b.hash && a.count === b.count && a.alive === b.alive;
  /*
   * A vs B is two loads of one build in one browser. There is no libm difference to forgive
   * here, so the float64 layer is held to the same exact-bit standard as the pool — this arm
   * is the reproducibility gate and nothing about it is negotiable.
   */
  const unitSame = a.uf64 === b.uf64 && a.uctl === b.uctl && a.units === b.units;
  /*
   * And the precondition for either comparison meaning anything: the two runs are at the same
   * point in the battle. This file has printed `simTime` since it was written and never compared
   * it, which is the difference between a number a human might notice and a check.
   */
  const timeFault = simTimeFault([a.simTime, b.simTime], a.at, ['A', 'B']);
  const same = poolSame && unitSame && !timeFault;
  if (timeFault) {
    console.log(`  SIM TIME FAULT  ${timeFault}`);
    console.log('    Unequal tick counts are not comparable. This is the rAF race in');
    console.log('    tools/lib/simclock.mjs, not the simulation.');
  }
  console.log(`  t+${String(a.at).padStart(3)}  A ${a.hash} (${a.alive}/${a.count})   ` +
    `B ${b.hash} (${b.alive}/${b.count})   ${poolSame ? 'IDENTICAL' : 'DIVERGED'}`);
  console.log(`         units  A ${a.uf64}/${a.uctl}   B ${b.uf64}/${b.uctl}   `
    + `${unitSame ? 'IDENTICAL' : (a.uctl !== b.uctl ? 'DIVERGED (control flow)' : 'DIVERGED (float64 only)')}`);
  if (!poolSame) diffs.push(a.at);
  if (!unitSame) unitDiffs.push(a.at);
  if (!same) failed++;
}

// Localise the first divergence: which soldier, which field.
let firstDiff = null;
if (diffs.length) {
  const at = diffs[0];
  console.log(`\n  localising the first divergence at t+${at}...`);
  const [da, db] = [await A.page.evaluate(() => window.__poolDump()), await B.page.evaluate(() => window.__poolDump())];
  const bad = [];
  const n = Math.min(da.count, db.count);
  for (let i = 0; i < n && bad.length < 12; i++) {
    const fields = [];
    if (da.x[i] !== db.x[i]) fields.push(`x ${da.x[i]} vs ${db.x[i]}`);
    if (da.z[i] !== db.z[i]) fields.push(`z ${da.z[i]} vs ${db.z[i]}`);
    if (da.state[i] !== db.state[i]) fields.push(`state ${da.state[i]} vs ${db.state[i]}`);
    if (da.hp[i] !== db.hp[i]) fields.push(`hp ${da.hp[i]} vs ${db.hp[i]}`);
    if (fields.length) bad.push({ i, unitId: da.unitId[i], fields });
  }
  let differing = 0;
  for (let i = 0; i < n; i++) {
    if (da.x[i] !== db.x[i] || da.z[i] !== db.z[i] || da.state[i] !== db.state[i] || da.hp[i] !== db.hp[i]) differing++;
  }
  firstDiff = { at, differing, of: n, sample: bad };
  console.log(`  ${differing}/${n} soldiers differ (${(differing / n * 100).toFixed(2)}%)`);
  for (const d of bad) console.log(`    soldier ${String(d.i).padStart(5)} (unit ${d.unitId}): ${d.fields.join('; ')}`);
}

/*
 * Localise a unit-layer divergence: which unit, which field, and how many representable
 * doubles apart. The ULP figure is the point — it is what separates "one libm call rounded
 * differently" (1–3 ULP) from "these two runs are simulating different battles" (thousands).
 */
let firstUnitDiff = null;
if (unitDiffs.length) {
  const at = unitDiffs[0];
  console.log(`\n  localising the first unit-layer divergence at t+${at}...`);
  const [ua, ub] = [await A.page.evaluate(() => window.__unitDump()), await B.page.evaluate(() => window.__unitDump())];
  const names = await A.page.evaluate(() => ({ f64: window.__UNIT_F64, ctl: window.__UNIT_CTL }));
  const bad = [];
  let f64Fields = 0, ctlFields = 0, worst = 0n;
  for (let i = 0; i < Math.min(ua.length, ub.length); i++) {
    const fields = [];
    for (let k = 0; k < names.f64.length; k++) {
      const [x, y] = [ua[i].f64[k], ub[i].f64[k]];
      if (Object.is(x, y)) continue;
      f64Fields++;
      const g = ulpGap(x, y);
      if (g > worst) worst = g;
      fields.push(`${names.f64[k]} ${x} vs ${y} (${g} ULP)`);
    }
    for (let k = 0; k < names.ctl.length; k++) {
      if (ua[i].ctl[k] === ub[i].ctl[k]) continue;
      ctlFields++;
      fields.push(`${names.ctl[k]} ${ua[i].ctl[k]} vs ${ub[i].ctl[k]}  [control flow]`);
    }
    if (fields.length && bad.length < 8) bad.push({ id: ua[i].id, typeId: ua[i].typeId, fields });
  }
  const total = Math.min(ua.length, ub.length) * (names.f64.length + names.ctl.length);
  firstUnitDiff = { at, f64Fields, ctlFields, of: total, worstUlp: String(worst), sample: bad };
  console.log(`  ${f64Fields} float64 field(s) and ${ctlFields} control field(s) differ of ${total}`
    + `; worst float64 gap ${worst} ULP`);
  for (const d of bad) console.log(`    unit ${String(d.id).padStart(3)} (${d.typeId}): ${d.fields.join('; ')}`);
}

// ---------------------------------------------------------------------------
// The same battle at every quality tier
// ---------------------------------------------------------------------------
/*
 * A graphics setting must not change the battle, and until this arm existed nothing checked it.
 *
 * The ruling is the owner's: "definitely graphics settings should not change outcome of battle".
 * The measurement that produced it — Campus Martius assault, seed 4265438264, hard — is that
 * `ultra` fielded 3,074 men and the ram crew died 16 m short of the door with nothing landed by
 * t+520, while `medium` fielded 3,009, landed 26 blows and opened the Porta Flaminia between
 * t+180 and t+240. Different headcount, different battle, different result, from a dropdown.
 *
 * ## Why this arm and not a cross-engine one
 *
 * `docs/MULTIPLAYER.md` §3 Stage 0 item 5 asks for a cross-engine arm and it still does not
 * exist. This is its sibling and it is the cheaper, nearer half of the same hole: two players on
 * different hardware pick different default tiers, so a match desyncs **before a single `Math`
 * call disagrees** — at t+0, on army size, with both engines computing identically. A
 * cross-engine arm run at one tier per machine would have reported that as a libm difference.
 *
 * ## How it is kept from passing vacuously
 *
 * This project's most expensive recurring failure is a check that compares something against
 * itself, so the arm carries four assertions and three of them exist only to make the fourth
 * mean something:
 *
 *   1. **The page loaded the tier it was asked for.** Read back off `engine.quality.tier`, not
 *      assumed from the URL. If `?quality=` were ignored this would be one tier measured four
 *      times, reporting perfect agreement.
 *   2. **The render half really differs.** Every render field is compared and at least one must
 *      have moved. Four identical settings objects agreeing on a hash proves nothing.
 *   3. **The simulation's own inputs are identical** — `pool.capacity` and the effective
 *      `unitSizeScale`. These are what the tier used to reach, and naming them separately is
 *      what turns a failure into a diagnosis instead of a mystery.
 *   4. **The hashes are identical** — pool, `uf64`, `uctl`, count, alive and unit count, at
 *      every compared checkpoint, exact bits. Same build, same browser, same machine, so this
 *      is held to the A-vs-B standard and not the baseline's: there is no libm difference to
 *      forgive between two page loads that differ only in a shadow-map size.
 */
const tierRows = [{ tier: GATE_TIER, marks: A.marks, settings: A.settings }];
if (TIER_ARM) {
  console.log(`\n--- cross-tier: the same battle at every tier, compared against run A`
    + ` (${GATE_TIER}) at ${TIER_AT.map((t) => `t+${t}`).join(', ')} ---`);
  for (const tier of ALL_TIERS.filter((t) => t !== GATE_TIER)) {
    const r = await run(`Q:${tier}`, tier, TIER_AT);
    tierRows.push({ tier, marks: r.marks, settings: r.settings, errors: r.errors });
    await r.page.close();
  }

  const gate = tierRows[0];
  const describe = (row) => `${String(row.tier).padEnd(6)} pool ${String(row.settings.sim.poolCap).padStart(6)}`
    + `  scale x${row.settings.sim.unitScale.toFixed(4)}`
    + `  maxSoldiers ${String(row.settings.maxSoldiers).padStart(6)}`
    + `  men ${String(row.marks[0].count).padStart(6)}`;
  console.log(`\n  ${describe(gate)}   <- run A, the tier the baseline is keyed to`);
  for (const row of tierRows.slice(1)) console.log(`  ${describe(row)}`);

  console.log('');
  for (const row of tierRows.slice(1)) {
    const tierTook = row.settings.tier === row.tier;
    const renderDiff = Object.keys(gate.settings.render)
      .filter((k) => gate.settings.render[k] !== row.settings.render[k]);
    const simSame = row.settings.sim.poolCap === gate.settings.sim.poolCap
      && Object.is(row.settings.sim.unitScale, gate.settings.sim.unitScale);

    const drift = [];
    for (const at of TIER_AT) {
      const a = gate.marks.find((m) => m.at === at);
      const b = row.marks.find((m) => m.at === at);
      if (!a || !b) { drift.push(`t+${at}: no mark`); continue; }
      const fields = [];
      for (const k of ['hash', 'count', 'alive', 'uf64', 'uctl', 'units']) {
        if (a[k] !== b[k]) fields.push(`${k} ${a[k]} vs ${b[k]}`);
      }
      if (fields.length) drift.push(`t+${at}  ${fields.join('  ')}`);
      /*
       * And the precondition, here as much as in A vs B: two runs at different tick counts are
       * not comparable, and four tiers is four more chances for the t+0 rAF race to make an
       * agreement meaningless. `tools/lib/simclock.mjs` stops the clock before it can start;
       * this is the check that it did.
       */
      const tf = simTimeFault([a.simTime, b.simTime], at, [GATE_TIER, row.tier]);
      if (tf) drift.push(`SIM TIME FAULT  ${tf}  — see tools/lib/simclock.mjs`);
    }

    const ok = tierTook && renderDiff.length > 0 && simSame && drift.length === 0;
    console.log(`  ${row.tier.padEnd(6)} vs ${GATE_TIER}   ${ok ? 'IDENTICAL BATTLE' : 'FAILED'}`
      + `   render fields differing: ${renderDiff.length} (${renderDiff.slice(0, 4).join(', ')}`
      + `${renderDiff.length > 4 ? ', …' : ''})`);
    if (!tierTook) {
      console.log(`    FAIL: asked for '${row.tier}' and the engine reports '${row.settings.tier}'.`);
      console.log('      The tier did not take, so this arm compared one tier with itself.');
    }
    if (!renderDiff.length) {
      console.log('    FAIL: not one render field differs from the gate tier. Two runs that are');
      console.log('      configured identically agreeing on a hash is not evidence of anything.');
    }
    if (!simSame) {
      console.log(`    FAIL: the simulation's inputs differ — pool ${gate.settings.sim.poolCap}`
        + ` vs ${row.settings.sim.poolCap}, unitSizeScale ${gate.settings.sim.unitScale}`
        + ` vs ${row.settings.sim.unitScale}.`);
      console.log('      A graphics setting is sizing the army. See `fittedUnitScale` in');
      console.log('      src/sim/battleConfig.ts and `SOLDIER_POOL_CAPACITY` in src/sim/types.ts.');
    }
    for (const d of drift) console.log(`    DRIFT ${d}`);
    if (!ok) failed++;
    for (const e of new Set(row.errors ?? [])) console.log(`    console: ${e}`);
  }
} else {
  console.log('\n--- cross-tier: SKIPPED (--tiers=off). Nothing checked that a graphics setting');
  console.log('    does not change the battle. ---');
}

// ---------------------------------------------------------------------------
// The battle has not changed since it was last recorded
// ---------------------------------------------------------------------------
/*
 * Run A only. B is already known to agree with it bit for bit, or the run has failed above,
 * and comparing both against the file would report one drift twice.
 */
let baseline = {};
try { baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8')); }
catch { /* first run in a tree that has none */ }

if (RECORD) {
  baseline[BATTLE_KEY] = {
    note: baseline[BATTLE_KEY]?.note
      ?? 'Recorded from run A. Re-record only in the same commit as the change that moved it.',
    checkpoints: Object.fromEntries(
      A.marks.map((m) => [String(m.at), {
        hash: m.hash, count: m.count, alive: m.alive,
        uf64: m.uf64, uctl: m.uctl, units: m.units,
      }])
    ),
  };
  const ordered = Object.fromEntries(Object.keys(baseline).sort().map((k) => [k, baseline[k]]));
  await writeFile(BASELINE_PATH, `${JSON.stringify(ordered, null, 2)}\n`);
  console.log(`\n• recorded ${A.marks.length} checkpoints for '${BATTLE_KEY}' in tools/determinism-baseline.json`);
} else {
  const pinned = baseline[BATTLE_KEY]?.checkpoints ?? null;
  console.log(`\n--- against tools/determinism-baseline.json ['${BATTLE_KEY}'] ---`);
  if (!pinned) {
    /*
     * Not a failure. A new `--battle` arm has no entry until somebody records one, and
     * failing here would break every agent who tries a battle nobody has pinned yet. It is
     * printed loudly instead, because a silent "no baseline" is the same hole this closes.
     */
    console.log(`  no baseline for this battle. Record one with:`);
    console.log(`    node tools/qa-determinism.mjs --record`
      + (args.get('battle') ? ` --battle='${args.get('battle')}'` : '')
      + ` --at=${CHECKPOINTS.join(',')}`);
  } else {
    let compared = 0;
    let hardDrift = 0;
    let softDrift = 0;
    let unpinnedUnits = 0;
    const unpinnedAt = [];
    for (const m of A.marks) {
      const want = pinned[String(m.at)];
      if (!want) { unpinnedAt.push(m.at); continue; }
      compared++;
      const poolSame = want.hash === m.hash && want.count === m.count && want.alive === m.alive;
      console.log(`  t+${String(m.at).padStart(3)}  pinned ${want.hash} (${want.alive}/${want.count})   `
        + `now ${m.hash} (${m.alive}/${m.count})   ${poolSame ? 'UNCHANGED' : 'DRIFTED'}`);
      if (!poolSame) hardDrift++;

      /*
       * An entry recorded before the unit layer was hashed has no uf64/uctl. Say so rather
       * than passing it: a silent skip is the shape of the hole this whole file exists to
       * close.
       */
      if (want.uf64 === undefined || want.uctl === undefined) { unpinnedUnits++; continue; }
      const f64Same = want.uf64 === m.uf64;
      const ctlSame = want.uctl === m.uctl && (want.units === undefined || want.units === m.units);
      const verdict = f64Same && ctlSame ? 'UNCHANGED'
        : !ctlSame ? 'DRIFTED (control flow — hard)'
          : STRICT_UNITS ? 'DRIFTED (float64 — hard)' : 'DRIFTED (float64 only — warning, --soft-units)';
      console.log(`         units  pinned ${want.uf64}/${want.uctl}   now ${m.uf64}/${m.uctl}   ${verdict}`);
      if (!ctlSame) hardDrift++;
      else if (!f64Same) { if (STRICT_UNITS) hardDrift++; else softDrift++; }
    }
    failed += hardDrift;
    warned += softDrift;

    if (compared === 0) {
      console.log(`  no checkpoint in --at=${CHECKPOINTS.join(',')} is pinned for this battle`);
    } else if (unpinnedAt.length) {
      console.log(`\n  ${unpinnedAt.length} checkpoint(s) ran but are not pinned: `
        + `${unpinnedAt.map((t) => `t+${t}`).join(', ')}. Nothing was checked there.`);
    }
    if (unpinnedUnits) {
      console.log(`\n  ${unpinnedUnits} pinned checkpoint(s) predate the unit-layer hash and carry no`);
      console.log('  uf64/uctl. Nothing is being checked on the float64 layer at those. Re-record.');
    }
    if (softDrift) {
      console.log(`\n  ${softDrift} checkpoint(s) drifted on uf64 only (warning: --soft-units),`);
      console.log('  with the pool hash and the');
      console.log('  control hash both unchanged. That is a PORTABILITY finding, not a reproducibility');
      console.log('  one, and it is a warning rather than a failure for a reason:');
      console.log('    · UnitGroupState is float64 integrated in place with no quantisation firewall,');
      console.log('      so one libm call rounding differently moves it within a second of sim time;');
      console.log('    · a Chromium point release is enough to do that — measured, twelve of');
      console.log('      fourteen Math functions changed between Chrome 149 and 151 — with no');
      console.log('      change to this tree at all;');
      console.log('    · the float32 pool round-trip hides it from `hash` for thousands of ticks.');
      console.log('  So: if you changed no simulation code, this is your browser and the battle still');
      console.log('  replays. If you did, you have moved the sim in a way the pool hash cannot yet see,');
      console.log('  and it will surface later as a real divergence. Re-record deliberately.');
      console.log('  NOTE: uf64 is a hard failure by default since src/sim/quantise.ts landed —');
      console.log('  the unit layer is float32-quantised at birth and at the end of every tick, so');
      console.log('  three browser engines now agree on it for six thousand ticks. You are seeing');
      console.log('  this text because --soft-units was passed. On an unchanged tree that is');
      console.log('  itself a finding: run tools/qa-xengine.mjs, which names the field.');
    }
    if (hardDrift) {
      console.log('\n  The battle is not the one that was pinned. That is a finding, not necessarily');
      console.log('  a fault: if you moved it on purpose, re-record in the same commit and say why.');
      console.log(`    node tools/qa-determinism.mjs --record`
        + (args.get('battle') ? ` --battle='${args.get('battle')}'` : '')
        + ` --at=${CHECKPOINTS.join(',')}`);
    }
  }
}

const errors = [...new Set([...A.errors, ...B.errors])];
if (errors.length) {
  console.log(`\n${errors.length} console error(s):`);
  for (const e of errors.slice(0, 10)) console.log(`  ${e}`);
}

if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT),
    JSON.stringify({
      battle: BATTLE_KEY, A: A.marks, B: B.marks, diffs, unitDiffs, firstDiff, firstUnitDiff,
      tiers: TIER_ARM
        ? tierRows.map((r) => ({ tier: r.tier, at: TIER_AT, settings: r.settings, marks: r.marks }))
        : null,
      errors,
    }, null, 2));
}
await browser.close();
await closeServer();
const tierNote = TIER_ARM
  ? `, identical at ${ALL_TIERS.length} tiers`
  : ', CROSS-TIER SKIPPED';
console.log(failed
  ? `\n✗ ${failed} failing check(s) across ${CHECKPOINTS.length} checkpoints (${A.marks.at(-1).count} soldiers)`
  : `\n✓ deterministic and unchanged across ${CHECKPOINTS.length} checkpoints at ${A.marks.at(-1).count} soldiers`
    + ` [${A.marks.at(-1).units} units]${tierNote}`);
if (warned) console.log(`  ${warned} portability warning(s) — see above. Not counted as a failure.`);
process.exit(failed ? 1 : 0);
