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
 * Usage: node tools/qa-determinism.mjs [--port=5226] [--at=0,30,90,150,200] [--json=path]
 *                                       [--battle=map=carthage&scenario=assault] [--render]
 *                                       [--record]
 *
 * `--battle` appends extra query parameters, so the gate can be run against a battle other
 * than the default one. It matters now that there are two besiegeable cities: an assault
 * takes an entirely different code path through `deployAssault` and `Siege`, and a garrison
 * pinned to a wall-walk is the part of the sim least like the field battle this gate has
 * always measured.
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
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5226);
const JSON_OUT = args.get('json') ?? null;
const CHECKPOINTS = (args.get('at') ?? '0,30,90,150,200').split(',').map(Number);
const EXTRA = args.get('battle') ? `&${args.get('battle')}` : '';
/** Rasterise the fast-forward. Off by default; see the note at the top of this file. */
const RENDER = args.get('render') === 'true';
/** Overwrite this battle's entry in the baseline instead of asserting against it. */
const RECORD = args.get('record') === 'true';

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

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1200))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 60000))) { console.error('vite did not start'); process.exit(1); }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

const HASH_FN = `
  window.__poolHash = () => {
    const p = window.__game.battle.pool;
    // FNV-1a over the exact bit patterns, so a 1-ULP drift is caught rather than rounded
    // away. Reading the float bits via a shared DataView avoids any toFixed() smoothing.
    const buf = new ArrayBuffer(4);
    const dv = new DataView(buf);
    let h = 0x811c9dc5;
    const mix = (u) => {
      h ^= u & 0xff;        h = (h * 0x01000193) >>> 0;
      h ^= (u >>> 8) & 0xff;  h = (h * 0x01000193) >>> 0;
      h ^= (u >>> 16) & 0xff; h = (h * 0x01000193) >>> 0;
      h ^= (u >>> 24) & 0xff; h = (h * 0x01000193) >>> 0;
    };
    const f = (v) => { dv.setFloat32(0, v); mix(dv.getUint32(0)); };
    let alive = 0;
    for (let i = 0; i < p.count; i++) {
      f(p.x[i]); f(p.z[i]); mix(p.state[i]); f(p.hp[i]);
      if (p.state[i] !== 10 && p.state[i] !== 11) alive++;
    }
    return { hash: (h >>> 0).toString(16).padStart(8, '0'), count: p.count, alive };
  };
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
    const h = await page.evaluate(() => window.__poolHash());
    marks.push({ at, ...h, simTime: await page.evaluate(() => +window.__game.simTime().toFixed(3)) });
    console.log(`  ${label}  t+${String(at).padStart(3)}  simTime ${marks.at(-1).simTime.toFixed(3)}  ` +
      `count ${h.count}  alive ${h.alive}  hash ${h.hash}`);
  }
  return { page, marks, errors };
}

console.log('• run A');
const A = await run('A');
console.log('• run B');
const B = await run('B');

let failed = 0;
console.log('\n--- comparison ---');
const diffs = [];
for (let i = 0; i < CHECKPOINTS.length; i++) {
  const a = A.marks[i], b = B.marks[i];
  const same = a.hash === b.hash && a.count === b.count && a.alive === b.alive;
  console.log(`  t+${String(a.at).padStart(3)}  A ${a.hash} (${a.alive}/${a.count})   ` +
    `B ${b.hash} (${b.alive}/${b.count})   ${same ? 'IDENTICAL' : 'DIVERGED'}`);
  if (!same) { failed++; diffs.push(a.at); }
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
      A.marks.map((m) => [String(m.at), { hash: m.hash, count: m.count, alive: m.alive }])
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
    for (const m of A.marks) {
      const want = pinned[String(m.at)];
      if (!want) continue;
      compared++;
      const same = want.hash === m.hash && want.count === m.count && want.alive === m.alive;
      console.log(`  t+${String(m.at).padStart(3)}  pinned ${want.hash} (${want.alive}/${want.count})   `
        + `now ${m.hash} (${m.alive}/${m.count})   ${same ? 'UNCHANGED' : 'DRIFTED'}`);
      if (!same) failed++;
    }
    if (compared === 0) {
      console.log(`  no checkpoint in --at=${CHECKPOINTS.join(',')} is pinned for this battle`);
    } else if (failed) {
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

if (JSON_OUT) await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify({ A: A.marks, B: B.marks, diffs, firstDiff, errors }, null, 2));
await browser.close();
if (server) server.kill('SIGTERM');
console.log(failed
  ? `\n✗ ${failed} failing check(s) across ${CHECKPOINTS.length} checkpoints (${A.marks.at(-1).count} soldiers)`
  : `\n✓ deterministic and unchanged across ${CHECKPOINTS.length} checkpoints at ${A.marks.at(-1).count} soldiers`);
process.exit(failed ? 1 : 0);
