#!/usr/bin/env node
/**
 * Is the 404 that `p2psmoke` reports this branch's, or does a single-player boot produce it too?
 *
 * A console error a gate collects is a check that will go red, so it has to be attributed before
 * anything is built on top of it. One page, no network, no room.
 */
import path from 'node:path';
import process from 'node:process';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PORT = 5957;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vite = await startVite({ port: PORT, root: ROOT, label: 'console404' });
const browser = await launchBrowser({ label: 'scratch/console404', port: PORT, channel: 'chrome' });
try {
  for (const q of ['menu=0&autoplay=1&quality=medium', 'mp=1']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errs = [];
    const bad = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => bad.push(`FAILED ${r.url()} ${r.failure()?.errorText ?? ''}`));
    page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
    await page.goto(`${vite.base}/?${q}`, { waitUntil: 'domcontentloaded' });
    if (q === 'mp=1') await sleep(4000);
    else await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
    await sleep(1500);
    console.log(`\n== ?${q} ==`);
    console.log(`  console errors (${errs.length}): ${errs.join(' | ') || '(none)'}`);
    console.log(`  bad responses (${bad.length}): ${bad.join(' | ') || '(none)'}`);
    await page.close();
  }
} finally {
  await browser.close();
  await vite.close();
}
