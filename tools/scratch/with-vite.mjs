#!/usr/bin/env node
/**
 * Run a probe that expects somebody else to have started the dev server.
 *
 * Several probes refuse to start one — `probe-budget.mjs` outright, `probe-wall.mjs` by
 * falling back to a stale `dist/` — and the reason is good: a probe that starts its own server
 * on a shared box can end up grading another branch's modules. This starts one through
 * `startVite()`, which is the budgeted path and records the tree it is serving, runs the tool
 * against it and takes it down again.
 *
 *   node tools/scratch/with-vite.mjs --port=5963 tools/probe-wall.mjs --port=5963
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { startVite } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);
const i = argv.findIndex((a) => !a.startsWith('--'));
if (i < 0) {
  console.error('usage: with-vite.mjs --port=N <tool.mjs> [tool args...]');
  process.exit(2);
}
const own = argv.slice(0, i);
const portArg = own.find((a) => a.startsWith('--port='));
const PORT = Number(portArg ? portArg.slice(7) : 5960);
const tool = argv[i];
const rest = argv.slice(i + 1);

const vite = await startVite({ port: PORT, root: ROOT, label: `with-vite:${path.basename(tool)}` });
let code = 0;
try {
  code = await new Promise((res) => {
    const p = spawn(process.execPath, [path.resolve(ROOT, tool), ...rest], { cwd: ROOT, stdio: 'inherit' });
    p.on('exit', (c) => res(c ?? 0));
  });
} finally {
  await vite.close();
}
process.exit(code);
