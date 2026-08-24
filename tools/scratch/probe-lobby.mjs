#!/usr/bin/env node
/** Measure the lobby: geometry, computed styles, hit-testing. Exploration only. */
import path from 'node:path';
import process from 'node:process';
import { launchBrowser } from '../lib/browser-budget.mjs';
import { ensureServer } from '../lib/menu-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PORT = 5941;
const SHOTS = path.join(ROOT, 'screenshots', 'two-commanders');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const s = await ensureServer({ port: PORT, root: ROOT, cacheDir: path.join(ROOT, '.vite-cache', `play-${PORT}`) });
const base = s.base;
const A = await launchBrowser({ label: 'probe-lobby', engine: 'chromium', args: ['--hide-scrollbars'], port: PORT, root: ROOT });
try {
  const ctx = await A.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${base}/?mp=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tc-lobby');
  await sleep(700);
  await page.screenshot({ path: path.join(SHOTS, '00-lobby-full-page.png'), fullPage: true });
  const m = await page.evaluate(() => {
    const q = (sel) => document.querySelector(sel);
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const cs = (el, props) => Object.fromEntries(props.map((p) => [p, getComputedStyle(el)[p]]));
    const hit = (el) => {
      const r = el.getBoundingClientRect();
      const cx = Math.round(r.x + r.width / 2);
      const cy = Math.round(r.y + r.height / 2);
      const inView = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight;
      const top = inView ? document.elementFromPoint(cx, cy) : null;
      return { cx, cy, inView, topEl: top ? `${top.tagName.toLowerCase()}${top.id ? '#' + top.id : ''}${top.className ? '.' + String(top.className).split(' ').join('.') : ''}` : null, isSelfOrChild: !!top && (top === el || el.contains(top)) };
    };
    const out = {};
    for (const [name, sel] of [['#menu-root', '#menu-root'], ['.tc-lobby', '.tc-lobby'], ['.card', '.tc-lobby .card'], ['h1', '.tc-lobby h1'], ['#tc-relay', '#tc-relay'], ['#tc-room', '#tc-room'], ['#tc-host', '#tc-host'], ['#tc-join', '#tc-join'], ['back link', '.tc-lobby .back']]) {
      const el = q(sel);
      if (!el) { out[name] = 'MISSING'; continue; }
      out[name] = { box: box(el), style: cs(el, ['pointerEvents', 'display', 'width', 'maxWidth', 'height', 'maxHeight', 'overflow', 'position', 'flexDirection', 'fontSize']), hit: hit(el) };
    }
    out.scroll = { bodyScrollHeight: document.body.scrollHeight, docScrollHeight: document.documentElement.scrollHeight, innerHeight: innerHeight, canScroll: document.documentElement.scrollHeight > innerHeight };
    // which stylesheet rules match .card
    const rules = [];
    for (const sh of document.styleSheets) {
      let rs; try { rs = sh.cssRules; } catch { continue; }
      for (const r of rs) {
        if (!r.selectorText) continue;
        if (/(^|[\s,>])\.card([\s,:{]|$)/.test(r.selectorText)) rules.push({ href: sh.href ? sh.href.split('/').pop() : '(inline)', sel: r.selectorText, css: r.style.cssText.slice(0, 220) });
      }
    }
    out.cardRules = rules;
    return out;
  });
  console.log(JSON.stringify(m, null, 1));
  // Is the room input reachable by a real mouse at all?
  console.log('\n-- real mouse click on #tc-room --');
  try {
    await page.click('#tc-room', { timeout: 4000 });
    console.log('  clicked ok; focused:', await page.evaluate(() => document.activeElement?.id));
  } catch (e) { console.log('  REFUSED:', String(e).split('\n')[0]); }
  console.log('\n-- real mouse click on #tc-host --');
  try {
    await page.click('#tc-host', { timeout: 4000 });
    console.log('  clicked ok');
  } catch (e) { console.log('  REFUSED:', String(e).split('\n')[0]); }
  console.log('\n-- keyboard: can you Tab to the fields? --');
  await page.keyboard.press('Tab');
  console.log('  after 1 Tab, active =', await page.evaluate(() => `${document.activeElement?.tagName}#${document.activeElement?.id}`));
  await page.keyboard.press('Tab');
  console.log('  after 2 Tab, active =', await page.evaluate(() => `${document.activeElement?.tagName}#${document.activeElement?.id}`));
} finally {
  await A.close();
  if (s.server) s.server.kill('SIGTERM');
}
process.exit(0);
