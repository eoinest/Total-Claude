#!/usr/bin/env node
/**
 * Scratch: boot all three maps through the front door, and confirm the skip still skips.
 *
 * Arm A — the player path. No flags at all: land on the front door, click BATTLE with a
 * real mouse, pick the map, press BEGIN BATTLE, wait for the world. `pageerror` and
 * `console.error` are captured for the whole run and any one of them fails the map.
 *
 * Arm B — the contract every probe in this repository depends on. `?menu=0` and
 * `?harness=1` must still reach a running battle with no menu built at all.
 */
import { chromium } from 'playwright';
import { spawnVite } from '../lib/devtree.mjs';

const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 5399);
const base = `http://127.0.0.1:${PORT}`;
const MAPS = ['campus-martius', 'carthage', 'pydna'];

const up = async (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(base, { signal: AbortSignal.timeout(2000) })).ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};
let server = null;
if (!(await up(1200))) {
  console.log(`• starting vite on ${PORT}`);
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
    { cwd: process.cwd(), stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } });
  if (!(await up(60000))) { console.error('vite did not start'); process.exit(1); }
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--hide-scrollbars'] });
let bad = 0;
const rows = [];

for (const map of MAPS) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  page.on('requestfailed', (r) => errs.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  const t0 = Date.now();
  await page.goto(`${base}/?quality=high&autoplay=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.menu.at-home .dest-battle', { timeout: 90000 });
  await page.click('.dest-battle');
  await page.waitForSelector('.menu .begin', { timeout: 60000 });
  await page.click(`.menu [data-map="${map}"]`);
  await page.waitForTimeout(300);
  const picked = await page.evaluate(() => [...document.querySelectorAll('.menu [data-map]')]
    .find((b) => b.classList.contains('on'))?.dataset.map ?? '?');
  await page.click('.menu .begin');
  let ready = false;
  try {
    await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 420000 });
    ready = true;
  } catch { /* recorded below */ }
  // The clock has to actually advance, not merely reach `ready`.
  await page.waitForTimeout(2500);
  const st = ready ? await page.evaluate(() => ({ t: window.__game.simTime(), men: window.__game.battle.pool.count })) : null;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const ok = ready && picked === map && !!st && st.t > 0 && errs.length === 0;
  if (!ok) bad++;
  rows.push({ arm: 'front door', map, ok, picked, secs, t: st?.t?.toFixed(2) ?? '-', men: st?.men ?? '-', errs: errs.slice(0, 3) });
  await page.close();
}

for (const map of MAPS) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  const t0 = Date.now();
  await page.goto(`${base}/?menu=0&map=${map}&quality=high&autoplay=1`, { waitUntil: 'domcontentloaded' });
  let ready = false;
  try {
    await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 420000 });
    ready = true;
  } catch { /* recorded below */ }
  await page.waitForTimeout(2000);
  const st = ready ? await page.evaluate(() => ({
    t: window.__game.simTime(),
    men: window.__game.battle.pool.count,
    menuBuilt: !!document.querySelector('.menu'),
  })) : null;
  const ok = ready && !!st && st.t > 0 && st.menuBuilt === false && errs.length === 0;
  if (!ok) bad++;
  rows.push({ arm: '?menu=0', map, ok, picked: map, secs: ((Date.now() - t0) / 1000).toFixed(1),
    t: st?.t?.toFixed(2) ?? '-', men: st?.men ?? '-', errs: errs.slice(0, 3),
    note: st ? `menu built ${st.menuBuilt}` : '' });
  await page.close();
}

for (const r of rows) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.arm.padEnd(11)} ${r.map.padEnd(15)} `
    + `boot ${String(r.secs).padStart(6)} s  t+${r.t}s  ${r.men} men  map on ${r.picked}`
    + (r.note ? `  ${r.note}` : '') + (r.errs.length ? `  ERRS ${r.errs.join(' | ')}` : '  no page errors'));
}
console.log(bad === 0 ? `\nPASS — ${rows.length}/${rows.length} boots clean` : `\nFAIL — ${bad} bad`);
await browser.close();
if (server) server.kill('SIGTERM');
process.exit(bad === 0 ? 0 : 1);
