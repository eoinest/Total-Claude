#!/usr/bin/env node
/**
 * The loop that would not die: launch a browser, close it, launch another, forever.
 *
 * A **fixture** for `tools/qa-supervisor.mjs`, modelled on `net-flake-load.mjs --runs=6` — the
 * script that on 23 Aug outlived a stopped agent, survived two `pkill` sweeps, and was found only
 * by walking parents up from a live browser.
 *
 * It launches a real headless browser, because the assertion that matters is that *browsers* die,
 * not that a `sleep` dies. It loads `about:blank` rather than the game: what is under test is the
 * lifetime of a process tree, and thirty seconds of Vite boot per iteration would make the test
 * too slow to run and would put a real GPU load on the owner's machine for no evidence at all.
 *
 * It takes a budget slot through `launchBrowser`, so the run is inside the cap like everything
 * else — a test for the supervisor that ignored the semaphore would be the wrong kind of proof.
 * The arm that needs a browser holding **no** slot gets it with `TC_BROWSER_BUDGET=off` in the
 * environment rather than with a second code path here, which keeps `chromium.launch()` out of
 * this file and out of `tools/check-browser-budget.mjs`'s allowlist.
 */

import path from 'node:path';
import process from 'node:process';
import { launchBrowser } from '../lib/browser-budget.mjs';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const RUNS = Number(arg('runs', '8'));
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

process.stdout.write(`browser-loop: pid ${process.pid}, ${RUNS} run(s), pgid ${process.getpgrp?.() ?? '?'}\n`);

for (let i = 0; i < RUNS; i++) {
  let browser = null;
  try {
    browser = await launchBrowser({ label: `browser-loop-${i}`, root: ROOT, quiet: true });
    const page = await browser.newPage();
    await page.goto('about:blank');
    process.stdout.write(`browser-loop: run ${i + 1}/${RUNS} has a browser open\n`);
    // Long enough that the test is certain to catch it mid-run, short enough that a forgotten
    // instance of this fixture cannot sit on the machine for an hour.
    await settle(20_000);
  } catch (err) {
    process.stdout.write(`browser-loop: run ${i + 1} failed: ${String(err?.message ?? err).split('\n')[0]}\n`);
    await settle(2000);
  } finally {
    try { await browser?.close(); } catch { /* being killed is the expected end of this script */ }
  }
}
process.stdout.write('browser-loop: finished all runs\n');
