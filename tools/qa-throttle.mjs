#!/usr/bin/env node
/**
 * Prove that the owner-present throttle is actually wired to a real browser.
 *
 * ## What was unproven
 *
 * `tools/scratch/gpu-bench.mjs` measures the *effect* of demoting an agent browser — 65.2 fps
 * against 118.0 for a browser standing in for the owner — but it applies the demotion itself,
 * with a direct `setQosTree`. That leaves the part that matters in production untested: whether
 * `launchBrowser` identifies its own browser correctly, whether the heartbeat notices the owner
 * sitting down, and whether the release path puts the process back.
 *
 * Every one of those has already been wrong once. `browserPid()` returned the wrong browser
 * when one process held two, and the gpu-bench arm that was supposed to show the throttle
 * helping showed it hurting instead. **A QoS demotion produces no error when it lands on the
 * wrong process, or on none**, so nothing but an assertion will catch it.
 *
 * ## The signature
 *
 * `ps -o pri` is the observable. A normal process on this machine reads **31**; one moved into
 * the background band by `taskpolicy -b` reads **4**; restoring puts it back to 31. Measured on
 * a plain spinning `node` process:
 *
 *     before:    pri 31   %cpu 100.0
 *     after -b:  pri  4   %cpu  98.0
 *     after -B:  pri 31   %cpu 100.0
 *
 * ## Usage
 *
 *     node tools/qa-throttle.mjs
 *
 * It takes one browser slot for about twenty seconds and loads `about:blank` — the plumbing
 * under test is the process tree and the heartbeat, and booting a nine-thousand-man battle to
 * check a scheduler priority would be its own small contribution to the problem.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

// Set before importing, so the first heartbeat and the launch-time reconcile both see it.
process.env.TC_OWNER = 'away';
process.env.TC_BUDGET_DIR = `/tmp/tc-qa-throttle-${process.pid}`;

const { launchBrowser } = await import('./lib/browser-budget.mjs');
const { processTree } = await import('./lib/machine-load.mjs');

const ROOT = path.resolve(import.meta.dirname, '..');
const BACKGROUND_PRI = 4;
const NORMAL_PRI_MIN = 20;

let pass = 0; const failures = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  FAIL  ${name}\n          ${detail}`); }
};

/** Scheduling priority of every process in a family, as `ps` sees it. */
const priorities = (root) => {
  const pids = processTree(root);
  const out = new Map();
  try {
    const raw = execFileSync('ps', ['-o', 'pid=,pri=', '-p', pids.join(',')], { encoding: 'utf8' });
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)/);
      if (m) out.set(Number(m[1]), Number(m[2]));
    }
  } catch { /* the family exited */ }
  return out;
};

const summarise = (m) => [...m.entries()].map(([p, r]) => `${p}:${r}`).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser = null;
const cleanup = async () => {
  try { await browser?.close(); } catch { /* already gone */ }
  try { const { rmSync } = await import('node:fs'); rmSync(process.env.TC_BUDGET_DIR, { recursive: true, force: true }); } catch { /* gone */ }
};

try {
  console.log('qa-throttle — is the demotion wired to a real browser?\n');
  console.log('  a background-band process reads pri 4; a normal one reads 31.\n');

  console.log('1. launch with the owner away');
  browser = await launchBrowser({ label: 'qa-throttle', root: ROOT, quiet: true });
  const pid = browser.budgetPid;
  check('launchBrowser identified its own browser process', Number.isFinite(pid) && pid > 1,
    `budgetPid is ${JSON.stringify(pid)} — without it nothing can be throttled`);
  if (!pid) throw new Error('cannot continue without a browser pid');

  const page = await browser.newPage();
  await page.goto('about:blank');
  await sleep(1000);

  const away = priorities(pid);
  console.log(`   family of ${away.size} process(es): ${summarise(away)}`);
  check('every process starts at normal priority',
    [...away.values()].every((p) => p >= NORMAL_PRI_MIN),
    `priorities were ${summarise(away)}`);

  /*
   * The heartbeat reads `ownerState()` fresh on every tick, and `ownerState()` reads
   * `process.env.TC_OWNER` fresh too — so changing it here is exactly the signal a real owner
   * sitting down produces, delivered through the real path rather than by calling the throttle.
   */
  console.log('\n2. the owner sits down and starts playing');
  process.env.TC_OWNER = 'playing';
  console.log('   waiting for the heartbeat (fires every 10 s)…');
  let demoted = null;
  for (let i = 0; i < 16; i++) {
    await sleep(1000);
    const p = priorities(pid);
    if ([...p.values()].some((v) => v <= BACKGROUND_PRI)) { demoted = { p, afterS: i + 1 }; break; }
  }
  check('the heartbeat demoted the browser within one interval',
    demoted != null, `still at ${summarise(priorities(pid))} after 16 s`);
  if (demoted) {
    console.log(`   after ${demoted.afterS}s: ${summarise(demoted.p)}`);
    check('the whole family went, not just the parent',
      [...demoted.p.values()].every((v) => v <= BACKGROUND_PRI),
      `mixed priorities ${summarise(demoted.p)} — a renderer left at normal priority is the`
      + ' one still competing for the GPU');
  }

  console.log('\n3. the owner leaves again');
  process.env.TC_OWNER = 'away';
  let restored = null;
  for (let i = 0; i < 16; i++) {
    await sleep(1000);
    const p = priorities(pid);
    if ([...p.values()].every((v) => v >= NORMAL_PRI_MIN)) { restored = { p, afterS: i + 1 }; break; }
  }
  check('the heartbeat restored it', restored != null,
    `still at ${summarise(priorities(pid))} after 16 s`);
  if (restored) console.log(`   after ${restored.afterS}s: ${summarise(restored.p)}`);

  /*
   * The one that costs somebody else if it is wrong: a process left demoted after we exit is a
   * browser somebody else inherits at a quarter of the machine, and nothing would ever say so.
   */
  console.log('\n4. demoted at the moment of release — does the process come back?');
  process.env.TC_OWNER = 'playing';
  let downAgain = false;
  for (let i = 0; i < 16 && !downAgain; i++) {
    await sleep(1000);
    downAgain = [...priorities(pid).values()].some((v) => v <= BACKGROUND_PRI);
  }
  check('demoted again, ready for the release test', downAgain, 'never went back down');
  const before = [...priorities(pid).keys()];
  browser.budgetSlot.release();
  await sleep(500);
  const after = priorities(pid);
  check('release() restored every process it had demoted',
    before.length > 0 && [...after.values()].every((v) => v >= NORMAL_PRI_MIN),
    `left at ${summarise(after)} — a process left in the background band outlives us`);
  console.log(`   after release: ${summarise(after)}`);
} finally {
  await cleanup();
}

console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${pass}/${pass + failures.length} assertions`);
if (failures.length) {
  for (const f of failures) console.log(`  ${f}`);
  console.log('\nThe throttle is not wired to anything. A demotion that lands on the wrong process,');
  console.log('or on none, produces no error — this is the only thing that would notice.');
  process.exitCode = 1;
} else {
  console.log('launchBrowser names its own browser, the heartbeat moves the whole family into and');
  console.log('out of the background band, and release() never leaves one there.');
}
