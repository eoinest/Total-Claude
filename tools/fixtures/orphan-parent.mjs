#!/usr/bin/env node
/**
 * The 23 Aug orphan, reconstructed: a script that starts a browser loop and then is killed.
 *
 * This is a **fixture**, not a tool. `tools/qa-supervisor.mjs` spawns it, waits for the loop to
 * have a browser open, and then SIGKILLs it — which is the exact shape of an agent being stopped:
 * no cleanup runs, no signal handler fires, nothing gets a chance to be polite.
 *
 * It writes one JSON line to the path in `--report=` as soon as the loop is registered, so the
 * test knows the process group to watch without having to guess at `ps` output.
 *
 * `--owned=0` spawns the loop the way it was spawned on 23 Aug — `detached: true`, unref'd, and
 * nothing watching it. That arm exists so the test can show the bug still reproduces, which is
 * the only way to know the passing arm is measuring the fix and not measuring nothing.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnOwned } from '../lib/process-registry.mjs';

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPORT = arg('report', '');
const OWNED = arg('owned', '1') !== '0';
const LOOP = path.join(import.meta.dirname, 'browser-loop.mjs');
const loopArgs = [LOOP, `--port=${arg('port', '5948')}`, `--runs=${arg('runs', '8')}`];

let out;
if (OWNED) {
  const job = spawnOwned(process.execPath, loopArgs, {
    label: 'orphan-loop', root: ROOT, port: Number(arg('port', '5948')), stdio: 'inherit',
  });
  out = { mode: 'owned', parentPid: process.pid, pgid: job.pgid, guardPid: job.guardPid, entry: job.entry };
} else {
  /*
   * The bug, deliberately. `detached: true` puts the child in its own group — which is what makes
   * it survive — and `unref` lets this process exit without it. Nothing watches anything. This is
   * `spawn('node', [...], { detached: true })` as written on 23 Aug, and the arm of the test that
   * uses it is the control.
   */
  const child = spawn(process.execPath, loopArgs, { cwd: ROOT, detached: true, stdio: 'inherit' });
  child.unref();
  out = { mode: 'unowned', parentPid: process.pid, pgid: child.pid, guardPid: null, entry: null };
}

if (REPORT) writeFileSync(REPORT, `${JSON.stringify(out)}\n`);
process.stdout.write(`orphan-parent: ${JSON.stringify(out)}\n`);

// Sit here doing nothing, waiting to be killed. A `setInterval` rather than a promise that never
// settles, so that a SIGKILL is the only way this ends and the test cannot accidentally pass
// because the parent exited on its own.
setInterval(() => {}, 1000);
