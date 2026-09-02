#!/usr/bin/env node
/**
 * A **fixture**: a process that owns a supervised job and then sits still.
 *
 * `tools/qa-supervisor.mjs` case 8 needs to remove *both* live mechanisms at once — the guard and
 * the owning process — and see whether the registry alone is enough. That cannot be done from
 * inside the test, because the test is the owning process and it has to survive to make the
 * assertions. So the ownership is delegated here: the test spawns this, kills the guard, kills
 * this, and is then holding nothing but a file on disk and a reaper.
 *
 * It reports the group and its own PID as one JSON line to `--report=`, then idles until killed.
 */

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

const job = spawnOwned('/bin/sh', ['-c', 'sleep 600 & sleep 600 & wait'], {
  label: arg('label', 'owned-job'), root: ROOT, stdio: ['ignore', 'ignore', 'ignore'],
});

const out = { ownerPid: process.pid, pgid: job.pgid, guardPid: job.guardPid, entry: job.entry };
if (REPORT) writeFileSync(REPORT, `${JSON.stringify(out)}\n`);
process.stdout.write(`owned-job: ${JSON.stringify(out)}\n`);

setInterval(() => {}, 1000);
