#!/usr/bin/env node
/**
 * How many headless browsers this machine can actually run at once.
 *
 * The cap in `tools/lib/browser-budget.mjs` had to be a number, and the instruction was to
 * measure it rather than guess it. This is the measurement. It runs the same shape of job the
 * gate runs — a private Vite server, a Chromium, the game booted through the real menu, and
 * some simulation advanced — at N = 1, 2, 4, 6, 8 concurrently, and reports for each N:
 *
 *   - wall clock for the whole sweep, and per job,
 *   - **throughput**, jobs per minute, which is the only number that says whether more
 *     concurrency actually bought anything,
 *   - peak and settled 1-minute load average,
 *   - peak resident memory across the browser and server processes.
 *
 * ## Why it pre-warms
 *
 * Each job gets its own `TC_VITE_CACHE_DIR`, because agent worktrees symlink `node_modules`
 * back to the main checkout and sharing Vite's default cache means several processes writing
 * one optimiser cache — see the long comment on `cacheDir` in `vite.config.ts`. A cold cache
 * costs tens of seconds, so an unwarmed sweep measures dependency optimisation rather than
 * browser concurrency, and it measures it *unequally*: the caches warmed by the N=1 sweep are
 * still warm for the N=2 sweep. `--prewarm` boots every port once, serially, first.
 *
 * ## The abort guard
 *
 * This tool exists because the machine was taken down by too many of exactly these. It samples
 * the load average twice a second and kills every child if it crosses `--abort-load`
 * (default 40, against 16 cores). That is well above any N it will be asked to run and well
 * below the 160 that required a hard recovery.
 *
 * ## Usage
 *
 *     node tools/scratch/bb-bench.mjs --prewarm --ns=1,2,4,6,8 --port-base=5940
 *     node tools/scratch/bb-bench.mjs --child --port=5940      # one job, run by the parent
 *
 * The budget itself is switched **off** for the children: this measures what the machine can
 * do, which is the input to the cap, so it cannot be gated by the cap.
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '../..');

const A = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1'];
}));

const PORT_BASE = Number(A.get('port-base') ?? 5940);
const SECONDS = Number(A.get('seconds') ?? 30);
const CACHE_ROOT = A.get('cache-root') ?? '/tmp/tc-bb-bench';
const SHOTS = Number(A.get('shots') ?? 0);

/* ─────────────────────────────── child: one job ─────────────────────────────── */

if (A.has('child')) {
  const PORT = Number(A.get('port'));
  const idx = PORT - PORT_BASE;
  const cacheDir = path.join(CACHE_ROOT, `p${PORT}`);
  mkdirSync(cacheDir, { recursive: true });
  const light = A.has('light');

  const t0 = Date.now();
  const { startVite, launchBrowser } = await import('../lib/browser-budget.mjs');
  const { bootThroughMenu } = await import('../lib/menu-boot.mjs');

  const server = await startVite({ port: PORT, root: ROOT, cacheDir, label: `bb-bench-${idx}` });
  const tServer = Date.now();
  const browser = await launchBrowser({ label: `bb-bench-${idx}`, port: PORT, root: ROOT });
  const tBrowser = Date.now();

  let ticks = null;
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    if (light) {
      // Prewarm: pull the whole module graph through Vite's transform cache and stop.
      await page.goto(`${server.base}/?autoplay=0`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.menu-sheet', { timeout: 120000 });
    } else {
      await bootThroughMenu(page, { base: server.base, tier: 'high' });
      const tReady = Date.now();
      /*
       * Two arms, because they load different parts of the machine.
       *
       * The default is `fastForward`, which is `advance(s, 1/60, { render: false })` — pure
       * CPU, one thread per browser, and what `qa-determinism` and `qa-replay` cost. Not
       * `engine.advance(s, 166)`: `main.ts` documents at length that a coarse frame step runs a
       * different number of ticks and is therefore a different battle.
       *
       * `--shots=N` is the other arm: advance, screenshot, repeat. That is what `shoot.mjs`,
       * `film.mjs` and every plate-taking probe actually do, and it contends for one GPU
       * rather than for sixteen cores. A cap measured only on the CPU arm would be too high
       * for half the tool directory, so the number has to be checked against both.
       */
      if (SHOTS > 0) {
        const per = SECONDS / SHOTS;
        for (let k = 0; k < SHOTS; k++) {
          await page.evaluate((sec) => window.__game.fastForward(sec), per);
          await page.screenshot({ type: 'jpeg', quality: 60 });
        }
      } else {
        await page.evaluate((s) => window.__game.fastForward(s), SECONDS);
      }
      ticks = await page.evaluate(() => ({
        t: +window.__game.simTime().toFixed(1),
        men: window.__game.battle?.pool?.count ?? null,
      }));
      process.stdout.write(`BB_JOB ${JSON.stringify({
        port: PORT, ok: true,
        serverMs: tServer - t0, browserMs: tBrowser - tServer,
        bootMs: tReady - tBrowser, simMs: Date.now() - tReady,
        totalMs: Date.now() - t0, simTime: ticks.t, men: ticks.men,
      })}\n`);
    }
  } finally {
    await browser.close();
    await server.close();
  }
  if (light) process.stdout.write(`BB_JOB ${JSON.stringify({ port: PORT, ok: true, warm: true, totalMs: Date.now() - t0 })}\n`);
  process.exit(0);
}

/* ─────────────────────────────── parent: the sweep ─────────────────────────────── */

const NS = String(A.get('ns') ?? '1,2,4,6,8').split(',').map(Number).filter(Boolean);
const ABORT_LOAD = Number(A.get('abort-load') ?? 40);
const CORES = os.cpus().length;

const ps = () => {
  try {
    return execFileSync('ps', ['-A', '-o', 'rss=,command='], { encoding: 'utf8', maxBuffer: 32 << 20 });
  } catch { return ''; }
};

const rssOfInterest = () => {
  let mb = 0; let procs = 0;
  for (const line of ps().split('\n')) {
    if (!/chrome-headless-shell|Chromium|vite-runner/.test(line)) continue;
    const m = line.match(/^\s*(\d+)/);
    if (m) { mb += Number(m[1]) / 1024; procs++; }
  }
  return { mb: Math.round(mb), procs };
};

/**
 * The instantaneous run queue, because the load average is the wrong instrument here.
 *
 * `os.loadavg()[0]` is an exponentially-weighted mean with a sixty-second time constant. The
 * first version of this bench ran twenty-three-second jobs and reported a peak load of 5.9
 * for one browser against a 5.4 baseline — not because one browser costs half a core, but
 * because the average had barely started to move. Two fixes, and this file uses both: jobs
 * long enough for the average to converge, and a direct count of runnable threads sampled
 * every second, which is the quantity the load average is an estimate of.
 */
const runQueue = () => {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'state='], { encoding: 'utf8', maxBuffer: 8 << 20 });
    let r = 0;
    for (const line of out.split('\n')) if (line.trim().startsWith('R')) r++;
    return r;
  } catch { return 0; }
};

const runSweep = async (n, { light = false } = {}) => {
  const started = Date.now();
  const children = [];
  const jobs = [];
  let peakLoad = 0; let peakRss = 0; let peakProcs = 0; let aborted = false;
  const loadSeries = []; const rqSeries = [];

  const sampler = setInterval(() => {
    const l = os.loadavg()[0];
    loadSeries.push(l);
    rqSeries.push(runQueue());
    if (l > peakLoad) peakLoad = l;
    const { mb, procs } = rssOfInterest();
    if (mb > peakRss) peakRss = mb;
    if (procs > peakProcs) peakProcs = procs;
    if (l > ABORT_LOAD) {
      aborted = true;
      for (const c of children) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }
    }
  }, 1000);

  await Promise.all(Array.from({ length: n }, (_, i) => new Promise((resolve) => {
    const port = PORT_BASE + i;
    const c = spawn(process.execPath, [
      HERE, '--child', `--port=${port}`, `--port-base=${PORT_BASE}`,
      `--seconds=${SECONDS}`, `--cache-root=${CACHE_ROOT}`, `--shots=${SHOTS}`,
      ...(light ? ['--light'] : []),
    ], {
      cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      // The budget is what we are measuring the input to. It must not gate the measurement.
      env: { ...process.env, TC_BROWSER_BUDGET: 'off', TC_VITE_CACHE_DIR: path.join(CACHE_ROOT, `p${port}`) },
    });
    children.push(c);
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += String(d); });
    c.stderr.on('data', (d) => { err += String(d); });
    c.once('exit', (code) => {
      const m = out.match(/BB_JOB (\{.*\})/);
      jobs.push(m ? JSON.parse(m[1]) : { port, ok: false, code, err: err.split('\n').slice(-4).join(' | ') });
      resolve();
    });
  })));

  clearInterval(sampler);
  const wall = Date.now() - started;
  // The last third only: the first third is startup and the average is still climbing.
  const tail = (a) => a.slice(Math.floor(a.length * 2 / 3));
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return {
    n, wall, jobs, peakLoad, peakRss, peakProcs, aborted,
    settledLoad: mean(tail(loadSeries)), peakRq: Math.max(0, ...rqSeries), meanRq: mean(tail(rqSeries)),
  };
};

const SETTLE_LOAD = Number(A.get('settle-load') ?? 5);
const settle = async (targetLoad = SETTLE_LOAD, maxMs = 120_000) => {
  const end = Date.now() + maxMs;
  while (Date.now() < end && os.loadavg()[0] > targetLoad) {
    await new Promise((r) => setTimeout(r, 5000));
  }
  return os.loadavg()[0];
};

console.log(`bb-bench — ${CORES} cores, ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB, `
  + `ports ${PORT_BASE}..${PORT_BASE + Math.max(...NS) - 1}, ${SECONDS}s of sim per job`
  + (SHOTS ? `, ${SHOTS} screenshots per job (GPU arm)` : ', render off (CPU arm)'));
console.log(`load now ${os.loadavg().map((x) => x.toFixed(2)).join(' ')} — abort at ${ABORT_LOAD}\n`);

const results = [];

const warmOne = (port) => new Promise((resolve) => {
  const t0 = Date.now();
  const c = spawn(process.execPath, [
    HERE, '--child', `--port=${port}`, `--port-base=${PORT_BASE}`, `--cache-root=${CACHE_ROOT}`, '--light',
  ], {
    cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TC_BROWSER_BUDGET: 'off', TC_VITE_CACHE_DIR: path.join(CACHE_ROOT, `p${port}`) },
  });
  let err = '';
  c.stderr.on('data', (d) => { err += String(d); });
  c.once('exit', (code) => resolve({ port, ms: Date.now() - t0, code, err: err.split('\n').slice(-3).join(' | ') }));
});

if (A.has('prewarm')) {
  const most = Math.max(...NS);
  console.log(`prewarming ${most} vite caches, one at a time…`);
  for (let i = 0; i < most; i++) {
    const r = await warmOne(PORT_BASE + i);
    console.log(`  port ${r.port}: ${(r.ms / 1000).toFixed(1)}s${r.code === 0 ? '' : `  FAILED (${r.code}) ${r.err}`}`);
  }
  console.log('');
}

for (const n of NS) {
  const before = await settle();
  process.stdout.write(`N=${n}  (load ${before.toFixed(2)} at start) … `);
  const r = await runSweep(n);
  results.push(r);
  const ok = r.jobs.filter((j) => j.ok);
  const times = ok.map((j) => j.totalMs / 1000).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : NaN;
  const tput = ok.length / (r.wall / 60000);
  console.log(`${(r.wall / 1000).toFixed(1)}s wall, ${ok.length}/${n} ok, `
    + `median job ${median.toFixed(1)}s, ${tput.toFixed(2)} jobs/min, `
    + `load peak ${r.peakLoad.toFixed(1)} settled ${r.settledLoad.toFixed(1)} `
    + `(${(r.settledLoad / CORES).toFixed(2)}x cores), runq mean ${r.meanRq.toFixed(1)} peak ${r.peakRq}, `
    + `peak RSS ${(r.peakRss / 1024).toFixed(1)} GiB over ${r.peakProcs} procs`
    + (r.aborted ? '  !! ABORTED ON LOAD' : ''));
  for (const j of r.jobs.filter((x) => !x.ok)) console.log(`    FAILED port ${j.port}: ${j.err ?? j.code}`);
}

console.log('\n| N | wall s | median job s | jobs/min | settled load | load/core | mean runq | peak RSS GiB | procs |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const r of results) {
  const ok = r.jobs.filter((j) => j.ok);
  const times = ok.map((j) => j.totalMs / 1000).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : NaN;
  console.log(`| ${r.n} | ${(r.wall / 1000).toFixed(1)} | ${median.toFixed(1)} | `
    + `${(ok.length / (r.wall / 60000)).toFixed(2)} | ${r.settledLoad.toFixed(1)} | `
    + `${(r.settledLoad / CORES).toFixed(2)} | ${r.meanRq.toFixed(1)} | `
    + `${(r.peakRss / 1024).toFixed(2)} | ${r.peakProcs} |`);
}

const out = A.get('json');
if (out) {
  writeFileSync(path.resolve(ROOT, out), JSON.stringify({ cores: CORES, seconds: SECONDS, results }, null, 2));
  console.log(`\nwrote ${out}`);
}
