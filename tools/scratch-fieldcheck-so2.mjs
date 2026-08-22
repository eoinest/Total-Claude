#!/usr/bin/env node
/**
 * Scratch: the field battle still reads like a field battle.
 *
 * `TopBar` and the dispatch were both changed for the siege, and both are on the path of
 * every battle. `readSiege` is supposed to return null wherever the arbiter has not found a
 * garrison on a wall, and the two panels are supposed to fall back to exactly what they
 * printed before. This checks that they do, because "the siege HUD works" and "the siege HUD
 * has not eaten the field HUD" are different claims and only the first was measured.
 *
 * Three things:
 *   - the top plaque shows a field phase and `data-siege` is absent,
 *   - the advantage slot carries the strength swing, not an objective,
 *   - the dispatch has no "The wall" block and the roll of honour is grouped by army.
 *
 * Usage: node tools/scratch-fieldcheck-so2.mjs [--port=5403]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 5403);
const W = 1600, H = 900;
const base = `http://127.0.0.1:${PORT}`;
/**
 * Extra query string, for a `?battle=` token. Same reason `probe-siegehud.mjs` has one: the
 * shipped order of battle takes longer to reach a verdict than this check is worth. Every
 * assertion below is about which words the panels print, not about how many men printed them.
 */
const EXTRA = process.argv.find((a) => a.startsWith('--extra='))?.slice(8);

const up = async (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(base, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; }
    catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};
let server = null;
if (!(await up(1200))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' } });
  if (!(await up(90000))) { console.error('vite did not start'); process.exit(1); }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});

let failed = 0;
const check = (ok, name, detail) => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        → ${detail}`);
};

const READ = () => {
  const t = (sel) => (document.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const g = window.__game;
  return {
    sim: +g.simTime().toFixed(0),
    phase: t('.tb-phase'),
    note: t('.tb-note'),
    adv: t('.tb-adv'),
    dataPhase: document.querySelector('.topbar')?.dataset.phase ?? '',
    dataSiege: document.querySelector('.topbar')?.dataset.siege ?? null,
    objective: !!g.engine.context.tryGet('battleFlow')?.objective,
    over: !!g.engine.context.tryGet('battleFlow')?.result,
  };
};

const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });

console.log('\n— the field battle, unchanged');
await page.goto(`${base}/?menu=0&map=campus-martius&scenario=field&autoplay=1&quality=high`
  + (EXTRA ? `&${EXTRA}` : ''),
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await page.waitForTimeout(1500);

let mid = null;
for (let i = 0; i < 40; i++) {
  await page.evaluate(() => window.__game.advance(20));
  await page.waitForTimeout(180);
  const r = await page.evaluate(READ);
  if (!mid && r.phase && r.phase.toLowerCase() !== 'deployment') mid = r;
  if (r.over) break;
}
const last = await page.evaluate(READ);
const m = mid ?? last;
check(!m.objective, 'no-wall-objective',
  `BattleFlowSystem.objective is null in a field battle (t+${m.sim})`);
check(m.dataSiege === null, 'no-siege-attribute',
  `topbar data-phase "${m.dataPhase}", data-siege ${JSON.stringify(m.dataSiege)}`);
check(!!m.phase && !/approach|breach|streets|ram at|wall reached/i.test(m.phase),
  'field-phase-heading', `plaque read "${m.phase}" · "${m.note}"`);
check(/advantage|evenly matched/i.test(m.adv), 'advantage-is-the-swing',
  `advantage slot read "${m.adv}"`);

await page.waitForTimeout(1500);
const rs = await page.evaluate(() => {
  const p = document.querySelector('.rs-panel');
  if (!p) return null;
  const heads = Array.from(p.querySelectorAll('.sec-head')).map((e) => e.textContent?.trim());
  return {
    verdict: (p.querySelector('.rs-verdict')?.textContent ?? '').trim(),
    heads,
    rows: Array.from(p.querySelectorAll('.rs-honours table tr')).map((tr) => {
      const h = tr.querySelector('.sec-head');
      return h ? `-- ${h.textContent?.trim()}` : (tr.querySelector('.h-name')?.textContent ?? '').trim();
    }),
  };
});
check(!!rs, 'dispatch-shown', rs ? `verdict "${rs.verdict}"` : 'no results panel');
if (rs) {
  check(!rs.heads.includes('The wall'), 'no-wall-block',
    `dispatch sections: ${JSON.stringify(rs.heads)}`);
  const groups = rs.rows.filter((r) => r.startsWith('-- '));
  check(groups.length === 2, 'honours-grouped-by-army',
    `${groups.length} standard(s): ${JSON.stringify(groups)}; ${rs.rows.length - groups.length} unit rows`);
}
check(errs.length === 0, 'clean-console', errs.length ? errs.slice(0, 3).join(' | ') : 'no errors');

await page.close();
await browser.close();
if (server) server.kill();
console.log(`\n${failed === 0 ? '✓' : '✗'} ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
