#!/usr/bin/env node
/**
 * `probe-budget.mjs` with a server of its own.
 *
 * `probe-budget` refuses to start a dev server — deliberately, so that it can never borrow
 * another branch's — and every caller is expected to bring one. This brings one through
 * `startVite()`, which is the budgeted path, runs the probe against it and takes the server
 * down with it.
 *
 *   node tools/scratch/fill-budget.mjs --port=5953 --map=campus-martius --tiers=ultra
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { startVite } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const PORT = Number(portArg ? portArg.slice(7) : 5953);

const vite = await startVite({ port: PORT, root: ROOT, label: 'fill-budget' });
let code = 0;
try {
  code = await new Promise((res) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'tools/probe-budget.mjs'), ...args], {
      cwd: ROOT, stdio: 'inherit',
    });
    p.on('exit', (c) => res(c ?? 0));
  });
} finally {
  await vite.close();
}
process.exit(code);
