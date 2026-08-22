#!/usr/bin/env node
/**
 * Proof that the browser budget actually blocks, and actually recovers.
 *
 * A limiter that has never been shown to block is not a limiter, and this repository has a
 * standing rule about checks that cannot fail. So this is the demonstration, committed rather
 * than described, and re-runnable in about ninety seconds.
 *
 * It runs three acts against a cap it sets for itself:
 *
 *   **1. It blocks.** `--n` children each ask for a browser against a cap of `--cap`. Exactly
 *   `cap` of them get one; the rest queue. Every child prints the instant it asked and the
 *   instant it got a slot, so the queueing is visible as a step function rather than asserted.
 *
 *   **2. It is observable.** While the queue is full the parent runs `tools/browsers.mjs` and
 *   prints it verbatim — holders, ports, how long each has held, and the waiting line.
 *
 *   **3. It recovers from a holder that dies badly.** One holder is **SIGKILLed** — no exit
 *   hook, no `finally`, nothing runs — and the queue must advance anyway. This is the machine
 *   crash in miniature: at load 160 nothing got to clean up, and a cap that cannot survive
 *   that would have refused every launch forever afterwards.
 *
 * The children open a real Chromium and no dev server: the cap counts browsers, and the Vite
 * orphan fix is proved separately (kill the parent of a `vite-runner.mjs` and watch the port
 * free itself within two seconds).
 *
 *     node tools/scratch/bb-proof.mjs --cap=2 --n=5 --hold=25
 */

import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '../..');
const A = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1'];
}));

const stamp = () => new Date().toISOString().slice(11, 23);

/* ───────────────────────────────── child ───────────────────────────────── */

if (A.has('child')) {
  const id = A.get('child');
  const hold = Number(A.get('hold') ?? 25) * 1000;
  const { launchBrowser } = await import('../lib/browser-budget.mjs');
  console.log(`[${stamp()}] child ${id}: asking for a slot`);
  const t0 = Date.now();
  const browser = await launchBrowser({
    label: `bb-proof-${id}`, port: 5960 + Number(id), root: ROOT, quiet: true,
  });
  console.log(`[${stamp()}] child ${id}: GOT slot ${browser.budgetSlot.slot} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const page = await browser.newPage();
  await page.goto('about:blank');
  await new Promise((r) => setTimeout(r, hold));
  await browser.close();
  console.log(`[${stamp()}] child ${id}: released slot ${browser.budgetSlot.slot}`);
  process.exit(0);
}

/* ───────────────────────────────── parent ───────────────────────────────── */

const CAP = Number(A.get('cap') ?? 2);
const N = Number(A.get('n') ?? 5);
const HOLD = Number(A.get('hold') ?? 25);

console.log(`bb-proof — cap ${CAP}, ${N} children, each holding ${HOLD}s\n`);

const kids = [];
const start = Date.now();
for (let i = 0; i < N; i++) {
  const c = spawn(process.execPath, [HERE, `--child=${i}`, `--hold=${HOLD}`], {
    cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, TC_MAX_BROWSERS: String(CAP), TC_BROWSER_WAIT_MS: '120000' },
  });
  kids.push(c);
  // A small stagger so the ordering in the log is the ordering they asked in, not a race.
  await new Promise((r) => setTimeout(r, 400));
}

// ── act 2: the observability command, while the queue is full ──
await new Promise((r) => setTimeout(r, 9000));
console.log(`\n──────── node tools/browsers.mjs, ${((Date.now() - start) / 1000).toFixed(0)}s in ────────`);
try {
  console.log(execFileSync(process.execPath, [path.join(ROOT, 'tools/browsers.mjs')], {
    encoding: 'utf8', env: { ...process.env, TC_MAX_BROWSERS: String(CAP) },
  }));
} catch (e) { console.log(String(e.stdout ?? e)); }
console.log('─────────────────────────────────────────────────────\n');

// ── act 3: SIGKILL a holder and watch the queue advance ──
await new Promise((r) => setTimeout(r, 2000));
const { listSlots } = await import('../lib/browser-budget.mjs');
const victim = listSlots().filter((s) => !s.stale)[0];
if (victim) {
  console.log(`[${stamp()}] SIGKILL to pid ${victim.rec.pid} (${victim.rec.label}, slot ${victim.slot}) `
    + '— no exit hook, no finally, nothing gets to clean up.');
  // The whole process group: the child, and the browser it will now never close.
  try { process.kill(-victim.rec.pid, 'SIGKILL'); } catch { try { process.kill(victim.rec.pid, 'SIGKILL'); } catch { /* gone */ } }
  console.log(`[${stamp()}] its slot is now held by a process that does not exist. `
    + 'Nothing ran to release it. The next waiter must get it anyway.\n');
}

await Promise.all(kids.map((c) => new Promise((r) => c.once('exit', r))));

console.log(`\n[${stamp()}] all children done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
console.log(`  Expect roughly ${Math.ceil(N / CAP)} waves of ${HOLD}s: `
  + `${N} children through ${CAP} slots.`);
const left = listSlots().filter((s) => !s.stale);
console.log(`  slots still held: ${left.length} (expected 0)`);
process.exit(left.length ? 1 : 0);
