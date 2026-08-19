#!/usr/bin/env node
/**
 * The two siege-HUD faults, measured at 1600x900 rather than eyeballed.
 *
 *   1. On a siege dispatch, is the roll of honour below the fold of `.rs-body`?
 *      Reported as the scroll offset at which the first honours row appears, against the
 *      height of the scroller — a positive number is the fault.
 *   2. Does "The Ram at the Gate" wrap in the top plaque? Reported as the number of client
 *      rects the label occupies, which is 2 when it has wrapped and 1 when it has not.
 *
 * Both are read after the sim has been stopped, so nothing moves under the measurement.
 *
 *   node tools/scratch/hudmeasure-vs.mjs --port=5483 --shots=/tmp/hud-before
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5483);
const SHOTS = args.get('shots') ?? '';
const MAP = args.get('map') ?? 'campus-martius';
const W = 1600, H = 900;

async function up(url, ms) {
  const d = Date.now() + ms;
  while (Date.now() < d) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.ok || r.status === 304) return true; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await up(base, 1200))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await up(base, 120000))) throw new Error('vite did not start');
  console.log(`• vite pid ${server.pid} on ${PORT} (${ROOT})`);
}
if (SHOTS) await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${String(e.message).slice(0, 200)}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`CONSOLE ${m.text().slice(0, 200)}`); });

await page.goto(`${base}/?menu=0&map=${MAP}&scenario=assault&autoplay=1&quality=high`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000, polling: 250 });
await page.waitForTimeout(1200);

// ---- 2. the plaque ---------------------------------------------------------
await page.evaluate(() => window.__game.engine.stop());
const plaque = await page.evaluate(() => {
  const el = document.querySelector('.tb-phase');
  const mid = document.querySelector('.tb-mid');
  const head = document.querySelector('.tb-head');
  if (!el) return null;
  const was = el.textContent;
  const read = (s) => {
    el.textContent = s;
    const r = el.getClientRects();
    const b = el.getBoundingClientRect();
    return {
      text: s, lines: r.length,
      w: +b.width.toFixed(1), h: +b.height.toFixed(1),
      lineH: +getComputedStyle(el).lineHeight,
      fontSize: getComputedStyle(el).fontSize,
      letterSpacing: getComputedStyle(el).letterSpacing,
    };
  };
  const rows = ['The Approach', 'The Ram at the Gate', 'The Wall Reached', 'The Breach', 'In the Streets'].map(read);
  // What each label would need on one line, so the plaque's min-width is a computed
  // number rather than a guess: measured in a detached clone so the live row cannot reflow
  // around it and change the answer it is being asked for.
  const probe = el.cloneNode(true);
  probe.style.position = 'absolute';
  probe.style.whiteSpace = 'nowrap';
  probe.style.visibility = 'hidden';
  el.parentElement.appendChild(probe);
  for (const r of rows) { probe.textContent = r.text; r.nowrapW = +probe.getBoundingClientRect().width.toFixed(1); }
  probe.remove();
  el.textContent = 'The Ram at the Gate';
  const b = (sel) => { const e = document.querySelector(sel); return e ? +e.getBoundingClientRect().width.toFixed(1) : null; };
  const cs = getComputedStyle(head);
  const boxes = {
    topbar: b('.topbar'), mid: b('.tb-mid'), head: b('.tb-head'),
    clock: b('.tb-clock'), speed: b('.tb-speed'),
    sideRome: b('.tb-side'), gap: cs.gap,
    em: parseFloat(getComputedStyle(document.querySelector('.hud')).fontSize),
    viewport: innerWidth,
  };
  return { rows, boxes, was };
});
console.log('--- top plaque ---');
for (const r of plaque.rows) console.log(`  lines=${r.h > r.lineH * 1.4 ? 2 : 1} box ${r.w}x${r.h} (line ${r.lineH})  needs ${r.nowrapW} on one line  "${r.text}"`);
console.log(`  .tb-head ${JSON.stringify(plaque.boxes)}`);
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'plaque-ram.png'), clip: { x: 260, y: 0, width: 1080, height: 130 } });

// ---- 1. the dispatch -------------------------------------------------------
// Drive to a verdict rather than faking one: the wall block only exists on a real siege
// result, and its height is the whole question.
let over = false;
for (let t = 0; t < 2400 && !over; t += 20) {
  await page.evaluate((s) => window.__game.engine.advance(s, 166), 20);
  over = await page.evaluate(() => !!window.__game.engine.context.get('battleFlow').result);
}
await page.evaluate(() => window.__game.engine.stop());
await page.waitForTimeout(1500);
const card = await page.evaluate(() => {
  const p = document.querySelector('.rs-panel');
  if (!p) return null;
  const body = p.querySelector('.rs-body');
  const br = body.getBoundingClientRect();
  const blocks = Array.from(p.querySelectorAll('.rs-honours')).map((e) => {
    const r = e.getBoundingClientRect();
    return {
      head: e.querySelector('.sec-head')?.textContent?.trim() ?? '',
      top: +(r.top - br.top + body.scrollTop).toFixed(0),
      bottom: +(r.bottom - br.top + body.scrollTop).toFixed(0),
      h: +r.height.toFixed(0),
    };
  });
  const rowsEl = Array.from(p.querySelectorAll('.rs-honours table tr'));
  const rows = rowsEl.map((tr) => {
    const r = tr.getBoundingClientRect();
    return {
      name: (tr.querySelector('.sec-head') ?? tr.querySelector('.h-name'))?.textContent?.trim() ?? '',
      top: +(r.top - br.top + body.scrollTop).toFixed(0),
      bottom: +(r.bottom - br.top + body.scrollTop).toFixed(0),
    };
  });
  const cols = p.querySelector('.rs-cols')?.getBoundingClientRect();
  // Where the card actually sits on the screen, not just how tall it is. `.rs-panel` is
  // `max-height: min(94vh, 100%)` inside a `place-items: center` grid, and a panel that
  // measures 846 px in a 900 px viewport is still off the bottom of it if the grid row it is
  // centred in is taller than the screen — which is a different fault from anything inside
  // `.rs-body`, and the one that decides whether the Dismiss button is reachable.
  const pr = p.getBoundingClientRect();
  const res = document.querySelector('.results').getBoundingClientRect();
  const hud = document.querySelector('.hud').getBoundingClientRect();
  const foot = p.querySelector('.rs-foot').getBoundingClientRect();
  const frame = {
    panel: { top: +pr.top.toFixed(0), bottom: +pr.bottom.toFixed(0), h: +pr.height.toFixed(0) },
    results: { top: +res.top.toFixed(0), h: +res.height.toFixed(0) },
    hud: { top: +hud.top.toFixed(0), h: +hud.height.toFixed(0) },
    foot: { top: +foot.top.toFixed(0), bottom: +foot.bottom.toFixed(0) },
    maxHeight: getComputedStyle(p).maxHeight,
  };
  return {
    frame,
    verdict: p.querySelector('.rs-verdict')?.textContent?.trim(),
    reason: p.querySelector('.rs-reason')?.textContent?.trim(),
    panelH: +p.getBoundingClientRect().height.toFixed(0),
    bodyH: +br.height.toFixed(0),
    bodyScrollH: body.scrollHeight,
    colsH: cols ? +cols.height.toFixed(0) : null,
    blocks, rows,
    viewport: { w: innerWidth, h: innerHeight },
  };
});
console.log('\n--- dispatch ---');
console.log(`  ${card?.verdict} / ${card?.reason}  panel ${card?.panelH}px  body ${card?.bodyH}px  content ${card?.bodyScrollH}px  cols ${card?.colsH}px`);
console.log(`  frame ${JSON.stringify(card?.frame)}`);
console.log(`  DISMISS ${card.frame.foot.bottom <= card.viewport.h ? 'on screen' : `OFF SCREEN by ${card.frame.foot.bottom - card.viewport.h} px`}`);
for (const b of card?.blocks ?? []) console.log(`  block "${b.head}"  top ${b.top}  bottom ${b.bottom}  h ${b.h}`);
const firstRow = (card?.rows ?? []).find((r) => r.name && !['Juthungi', 'Rome', 'Carthage'].includes(r.name));
const lastRow = (card?.rows ?? []).at(-1);
console.log(`  first honours row  top ${firstRow?.top} ("${firstRow?.name}")`);
console.log(`  last honours row   bottom ${lastRow?.bottom} ("${lastRow?.name}")`);
console.log(`  BELOW THE FOLD by ${Math.max(0, (lastRow?.bottom ?? 0) - (card?.bodyH ?? 0))} px`
  + `  (rows visible without scrolling: ${(card?.rows ?? []).filter((r) => r.bottom <= (card?.bodyH ?? 0)).length}/${(card?.rows ?? []).length})`);
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'dispatch.png') });

console.log(errors.length ? `\n!! ${errors.length} errors: ${[...new Set(errors)].slice(0, 5).join(' | ')}` : '\nno page errors');
await page.close();
await browser.close();
if (server) { server.kill('SIGTERM'); console.log(`• killed vite ${server.pid}`); }
