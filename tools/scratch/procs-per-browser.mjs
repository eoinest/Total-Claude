#!/usr/bin/env node
/**
 * How many OS processes is one headless browser, actually?
 *
 * `tools/browsers.mjs` says "six or seven" in a warning. The owner has asked twice how many
 * *processes* are running, so the number the process ceiling is derived from should be measured
 * on this machine rather than quoted. Two arms: an idle browser on `about:blank`, and a browser
 * with the real game loaded, which is the only shape any gate here actually produces.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) || 5947);

const count = () => {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const lines = out.split('\n').filter((l) => /chrome-headless-shell/.test(l) && !/\bgrep\b/.test(l));
  const types = {};
  for (const l of lines) {
    const m = l.match(/--type=(\S+)/);
    const k = m ? m[1] : '(browser)';
    types[k] = (types[k] || 0) + 1;
  }
  const vite = out.split('\n').filter((l) => /vite-runner\.mjs/.test(l)).length;
  return { chromium: lines.length, vite, types };
};

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (what, c) => console.log(`${what.padEnd(30)} chromium ${String(c.chromium).padEnd(3)} vite ${c.vite}   ${JSON.stringify(c.types)}`);

say('before', count());
const browser = await launchBrowser({ label: 'procs-per-browser', port: PORT, root: ROOT, quiet: true });
await settle(1200);
say('browser, no page', count());
const server = await startVite({ port: PORT, root: ROOT, label: 'procs-per-browser', slot: browser.budgetSlot });
await settle(800);
say('+ vite', count());
const page = await browser.newPage();
await page.goto(`${server.base}/`, { waitUntil: 'load', timeout: 120_000 });
await settle(3000);
say('+ menu page loaded', count());
try {
  await page.evaluate(() => { document.querySelector('canvas')?.dispatchEvent(new Event('focus')); });
  await settle(2000);
} catch { /* the menu shape is not the point of this measurement */ }
say('+ settled', count());
await browser.close();
await server.close();
await settle(2000);
say('after close', count());
