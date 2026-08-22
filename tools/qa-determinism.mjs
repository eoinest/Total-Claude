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
 *                                       [--strict-units]
 *
 * `--battle` appends extra query parameters, so the gate can be run against a battle other
 * than the default one. It matters now that there are two besiegeable cities: an assault
 * takes an entirely different code path through `deployAssault` and `Siege`, and a garrison
 * pinned to a wall-walk is the part of the sim least like the field battle this gate has
 * always measured.
 *
 * **Check that a new checkpoint measures the battle you think it does.** `--battle` is the
 * flag; an unknown flag is silently ignored and the run measures the field battle instead.
 * The tell is the headcount: 8,632 for `default`, 3,074 for Rome's assault, 3,440 for
 * Carthage's. That is printed on every line for exactly this reason.
 *
 * **And check that it measures the tree you think it does.** This file used to reuse any
 * listener that answered on `--port`, which in a checkout with eighty worktrees on a handful of
 * default ports means it could measure another agent's branch against this tree's baseline and
 * report the verdict with complete confidence. It now proves the listener serves this tree
 * before reusing it — every `.ts` under `src/`, through Vite's `?raw` route, about 200 ms — and
 * **exits 2** naming the differing files if it does not. `--port=59xx` to own your own. See
 * `tools/lib/devtree.mjs`.
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

import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { ownDevServer } from './lib/devtree.mjs';

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
 * Make a float64 unit-layer drift against the *baseline* a failure rather than a warning.
 *
 * Off by default. `uf64` is exact-bit and the measurement says a Chromium point release moves
 * it on its own, so defaulting this on would red the gate for every agent every time the
 * browser updated. On, this file becomes a portability gate rather than a reproducibility one.
 */
const STRICT_UNITS = args.get('strict-units') === 'true';

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

/*
 * ## The port, and the tree on the other end of it
 *
 * This block used to be four lines: try the port, and if something answers, use it. That is a
 * real speed-up and it was also a silent defect of exactly the kind the rest of this file
 * exists to prevent. "Something answers on 5226" and "the tree I am measuring is on 5226" are
 * different claims. There are eighty git worktrees in this checkout and they all default to the
 * same handful of ports, so an agent who runs this arm while another agent's Vite holds 5226
 * gets somebody else's hashes, compares them against *this* tree's baseline, and reports a
 * drift or an all-clear with complete confidence. **An arm that measures the wrong tree is the
 * same defect as an arm that measures the wrong battle**, and this file has already shipped
 * that one (`--battle=rome`).
 *
 * `ownDevServer` refuses instead. It asks the listener for every `.ts` under `src/` through
 * Vite's `?raw` route — which returns the file's exact bytes as they are on the disk the server
 * is rooted at — and compares them with this disk. 189 files in about 200 ms. If they do not
 * match it names the differing paths and exits 2 rather than choosing a port for you: a harness
 * that silently moves ports is a harness whose printed port is a guess.
 *
 * It caught a live collision on its first outing — another agent's worktree on the port, with
 * ten files different — which is the only reason this comment is written in the past tense.
 *
 * It also spawns Vite's binary rather than `npx vite`, and in its own process group. `npx` is a
 * wrapper *around* Vite: SIGTERM reaches the wrapper, the wrapper exits, and the server keeps
 * the port. That is where nineteen orphaned Vite processes came from in one day.
 */
const { base, kill: killServer } = await ownDevServer({
  root: ROOT,
  port: PORT,
  cacheDir: process.env.TC_VITE_CACHE_DIR ?? null,
  label: 'qa-determinism',
});

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
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
async function run(label) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}/?harness=1&quality=high&w=960&h=540${EXTRA}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
  // Stop the rAF loop: otherwise wall-clock time between Playwright calls advances one run
  // more than the other and every hash diverges for an uninteresting reason.
  await page.evaluate(() => window.__game.engine.stop());
  await page.evaluate(HASH_FN);

  const marks = [];
  let prev = 0;
  for (const at of CHECKPOINTS) {
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
  return { page, marks, errors };
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
  const same = poolSame && unitSame;
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
          : STRICT_UNITS ? 'DRIFTED (float64 — hard, --strict-units)' : 'DRIFTED (float64 only — warning)';
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
      console.log(`\n  ${softDrift} checkpoint(s) drifted on uf64 only, with the pool hash and the`);
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
      console.log('  and it will surface later as a real divergence. Re-record deliberately, or run');
      console.log('  --strict-units to make it a failure while you investigate.');
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
    JSON.stringify({ battle: BATTLE_KEY, A: A.marks, B: B.marks, diffs, unitDiffs, firstDiff, firstUnitDiff, errors }, null, 2));
}
await browser.close();
killServer();
console.log(failed
  ? `\n✗ ${failed} failing check(s) across ${CHECKPOINTS.length} checkpoints (${A.marks.at(-1).count} soldiers)`
  : `\n✓ deterministic and unchanged across ${CHECKPOINTS.length} checkpoints at ${A.marks.at(-1).count} soldiers`
    + ` [${A.marks.at(-1).units} units]`);
if (warned) console.log(`  ${warned} portability warning(s) — see above. Not counted as a failure.`);
process.exit(failed ? 1 : 0);
