#!/usr/bin/env node
/**
 * Run one or more `qa-net` arms repeatedly *under deliberate load*, and report a pass rate.
 *
 * ## Why this exists
 *
 * `same-battle` and `siege-same-battle` were reported red twice in four runs and twice in five,
 * green at the branch point both times, with `checkpoints-agreed` green throughout — so the
 * hashes were never actually compared and the failure was always the same sentence: *"they
 * stopped at different ticks"*. A single green run is not evidence against that, and neither is
 * a single red one. What settles it is a rate, taken twice, with the load held the same.
 *
 * The load matters because the mechanism is a *scheduling* one: the relay is SIGSTOPped so the
 * two clients can be compared at rest, and node queues unflushed socket writes **inside the
 * process**, where a stopped process will never send them. Whether that queue is empty at the
 * moment of the stop depends on how the two pages were paced, and how they were paced depends
 * on what else is on the machine. On an idle laptop the arms are green. That is the whole
 * problem.
 *
 * ## What it does
 *
 *   - spawns `--load=N` CPU spinners for the duration and reports the load average it achieved,
 *     so a rate is quoted against a number rather than against "it felt busy";
 *   - runs `node tools/qa-net.mjs --only=<arms>` `--runs=N` times, serially, because the browser
 *     budget is four and one qa-net is two of them;
 *   - parses each check by name, and separately extracts the "stopped at different ticks" pair,
 *     the settle nudge count and the relay's last agreed tick, because *which* way it went red
 *     is the finding;
 *   - prints a per-check pass rate and writes the raw runs to `--json=`.
 *
 * Serial, never parallel: two qa-nets at once is four browser slots and both would then be
 * measuring a machine that this script is itself the biggest load on.
 *
 * Usage:
 *   node tools/scratch/net-flake-load.mjs --runs=6 --arms=battle,siege --load=6 \
 *        --port=5939 --relay=5989 --json=/tmp/flake-before.json
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));

const RUNS = Number(args.get('runs') ?? 5);
const ARMS = args.get('arms') ?? 'battle,siege';
const LOAD = Number(args.get('load') ?? 6);
const PORT = Number(args.get('port') ?? 5939);
const RELAY = Number(args.get('relay') ?? 5989);
const JSON_OUT = args.get('json') ?? null;
const LABEL = args.get('label') ?? 'run';
const EXTRA = (args.get('extra') ?? '').split(' ').filter(Boolean);

// ---------------------------------------------------------------------------
// The load
// ---------------------------------------------------------------------------

/*
 * Spinners, not a fork bomb.
 *
 * The failure this reproduces is contention for *scheduling*, and a busy-loop per core is the
 * cheapest honest way to produce it. The count is bounded and every child is killed on the way
 * out, including on a throw — this machine reached load average 160 once already and the fix
 * for that is not a measurement script that reintroduces it.
 */
const spinners = [];
const startLoad = (n) => {
  for (let i = 0; i < n; i++) {
    const p = spawn(process.execPath, ['-e', 'for(;;){Math.sqrt(Math.random());}'],
      { stdio: 'ignore', detached: false });
    spinners.push(p);
  }
};
const stopLoad = () => { for (const p of spinners.splice(0)) { try { p.kill('SIGKILL'); } catch { /* gone */ } } };
process.on('exit', stopLoad);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { stopLoad(); process.exit(130); });
}
process.on('uncaughtException', (e) => { stopLoad(); console.error(e); process.exit(1); });

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

const CHECK = /^\s{2}(PASS|FAIL)\s{2}(\S+)\s/;

const runOnce = (i) => new Promise((resolve) => {
  const started = Date.now();
  const p = spawn(process.execPath, [path.join(ROOT, 'tools', 'qa-net.mjs'),
    `--only=${ARMS}`, `--port=${PORT}`, `--relay=${RELAY}`, ...EXTRA],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });

  let out = '';
  p.stdout.on('data', (d) => { out += String(d); });
  p.stderr.on('data', (d) => { out += String(d); });
  p.on('exit', (code) => {
    const checks = {};
    for (const line of out.split('\n')) {
      const m = line.match(CHECK);
      if (m) checks[m[2]] = m[1] === 'PASS';
    }
    const apart = [...out.matchAll(/they stopped at different ticks: ([\d,]+) and ([\d,]+)/g)]
      .map((m) => [m[1], m[2]]);
    const settle = [...out.matchAll(/settle: (.*)$/gm)].map((m) => m[1]);
    resolve({
      run: i, code, ms: Date.now() - started, checks, apart, settle,
      load: os.loadavg().map((n) => +n.toFixed(2)),
      tail: out.split('\n').filter((l) => /FAIL|Error|error:/.test(l)).slice(0, 8),
    });
  });
});

// ---------------------------------------------------------------------------

console.log(`net-flake-load — ${RUNS} run(s) of --only=${ARMS} on port ${PORT}/relay ${RELAY}`);
console.log(`  load before: ${os.loadavg().map((n) => n.toFixed(2)).join(' / ')} on ${os.cpus().length} cores`);
if (LOAD > 0) {
  startLoad(LOAD);
  await new Promise((r) => setTimeout(r, 20_000));
  console.log(`  ${LOAD} spinner(s) up; load now ${os.loadavg().map((n) => n.toFixed(2)).join(' / ')}`);
}

const runs = [];
try {
  for (let i = 1; i <= RUNS; i++) {
    process.stdout.write(`\n--- run ${i}/${RUNS} `.padEnd(72, '-') + '\n');
    const r = await runOnce(i);
    runs.push(r);
    const names = Object.keys(r.checks);
    const bad = names.filter((n) => !r.checks[n]);
    console.log(`  exit ${r.code} in ${(r.ms / 1000).toFixed(0)}s; `
      + `${names.length - bad.length}/${names.length} checks; load ${r.load.join(' / ')}`);
    if (bad.length) console.log(`  RED: ${bad.join(', ')}`);
    for (const [x, y] of r.apart) console.log(`       apart: ${x} vs ${y}`);
    for (const s of r.settle) console.log(`       ${s}`);
  }
} finally {
  stopLoad();
}

// ---------------------------------------------------------------------------
// The rate
// ---------------------------------------------------------------------------

const allNames = [...new Set(runs.flatMap((r) => Object.keys(r.checks)))].sort();
console.log(`\n=== ${LABEL}: ${runs.length} runs, --only=${ARMS}, ${LOAD} spinners ===`);
let anyRed = false;
for (const n of allNames) {
  const seen = runs.filter((r) => n in r.checks);
  const ok = seen.filter((r) => r.checks[n]).length;
  if (ok < seen.length) anyRed = true;
  const mark = ok === seen.length ? '     ' : ' <<< ';
  console.log(`  ${mark}${n.padEnd(26)} ${ok}/${seen.length}`);
}
const fullyGreen = runs.filter((r) => Object.values(r.checks).every(Boolean)).length;
console.log(`\n  whole-run green: ${fullyGreen}/${runs.length}`);
console.log(`  ${anyRed ? 'AT LEAST ONE CHECK FLAKED' : 'every check green in every run'}`);

if (JSON_OUT) {
  writeFileSync(JSON_OUT, `${JSON.stringify({
    label: LABEL, arms: ARMS, runs: RUNS, spinners: LOAD, cores: os.cpus().length,
    at: new Date().toISOString(), results: runs,
  }, null, 2)}\n`);
  console.log(`  wrote ${JSON_OUT}`);
}
