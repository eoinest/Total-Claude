#!/usr/bin/env node
/**
 * Photograph and hit-test the rebuilt lobby. Exploration only; the gate is `qa-net --only=lobby`.
 *
 *   node tools/scratch/lobby-shots.mjs [--port=5946] [--relay=5947] [--no-relay]
 */
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { launchBrowser } from '../lib/browser-budget.mjs';
import { ensureServer } from '../lib/menu-boot.mjs';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PORT = Number(args.get('port') ?? 5946);
const RELAY = Number(args.get('relay') ?? 5947);
const SHOTS = path.join(ROOT, 'screenshots', 'two-commanders');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let relay = null;
if (!args.has('no-relay')) {
  relay = spawn('node', [path.join(ROOT, 'tools', 'relay.mjs'), `--port=${RELAY}`,
    `--parent=${process.pid}`, '--quiet'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(`http://127.0.0.1:${RELAY}/health`).then((r) => r.ok).catch(() => false);
    if (ok) break;
    await sleep(250);
  }
}

const s = await ensureServer({
  port: PORT, root: ROOT, cacheDir: path.join(ROOT, '.vite-cache', `lobby-${PORT}`),
});
const A = await launchBrowser({
  label: 'lobby-shots', engine: 'chromium', args: ['--hide-scrollbars'], port: PORT, root: ROOT,
});
const shot = async (page, name) => {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  console.log(`  shot ${name}`);
};
const errs = [];
try {
  const ctx = await A.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });

  await page.goto(`${s.base}/?mp=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tc-lobby', { timeout: 20000 });
  await sleep(500);
  await shot(page, '50-lobby-fresh');

  const m = await page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const hit = (el) => {
      const r = el.getBoundingClientRect();
      const cx = Math.round(r.x + r.width / 2);
      const cy = Math.round(r.y + r.height / 2);
      const inView = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight;
      const top = inView ? document.elementFromPoint(cx, cy) : null;
      return { inView, self: !!top && (top === el || el.contains(top)),
        top: top ? `${top.tagName.toLowerCase()}${top.id ? `#${top.id}` : ''}` : null };
    };
    const out = {};
    for (const [n, sel] of [['sheet', '.tc-sheet'], ['room', '#tc-room'], ['host', '#tc-host'],
      ['join', '#tc-join'], ['relay', '#tc-relay'], ['back', '.tc-back']]) {
      const el = document.querySelector(sel);
      out[n] = el ? { box: box(el), pe: getComputedStyle(el).pointerEvents, hit: hit(el) } : 'MISSING';
    }
    out.scroll = { doc: document.documentElement.scrollHeight, inner: innerHeight,
      lobby: document.querySelector('.tc-lobby').scrollHeight };
    return out;
  });
  console.log(JSON.stringify(m, null, 1));

  // Type a code with a character the alphabet does not have.
  await page.click('#tc-room');
  await page.type('#tc-room', 'ROMEX', { delay: 30 });
  await sleep(200);
  console.log('  typed ROMEX ->', await page.inputValue('#tc-room'),
    '| hint:', (await page.textContent('#tc-room-hint')).trim().slice(0, 110));
  await shot(page, '51-lobby-dropped-character');

  await page.fill('#tc-room', '');
  await page.type('#tc-room', 'RMEXQ', { delay: 30 });
  await page.fill('#tc-relay', `ws://127.0.0.1:${RELAY}`);
  await sleep(150);
  await shot(page, '52-lobby-code-typed');

  await page.click('#tc-host');
  await page.waitForSelector('#tc-code', { timeout: 15000 }).catch(() => {});
  await sleep(400);
  console.log('  after Create, note:',
    (await page.textContent('.tc-sheet')).replace(/\s+/g, ' ').slice(0, 240));
  await shot(page, '53-lobby-room-open');

  // A small viewport, to prove the sheet scrolls rather than clipping.
  const small = await ctx.newPage();
  small.on('pageerror', (e) => errs.push(`pageerror(small): ${e.message}`));
  await small.setViewportSize({ width: 900, height: 520 });
  await small.goto(`${s.base}/?mp=1`, { waitUntil: 'domcontentloaded' });
  await small.waitForSelector('.tc-lobby', { timeout: 20000 });
  await sleep(400);
  const sc = await small.evaluate(() => {
    const l = document.querySelector('.tc-lobby');
    l.scrollTop = 9999;
    return { scrollHeight: l.scrollHeight, clientHeight: l.clientHeight, scrollTop: l.scrollTop,
      backVisible: (() => { const r = document.querySelector('.tc-back').getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight; })() };
  });
  console.log('  small viewport:', JSON.stringify(sc));
  await shot(small, '54-lobby-small-viewport-scrolled');

  // An unreachable relay, through the form.
  const dead = await ctx.newPage();
  dead.on('pageerror', (e) => errs.push(`pageerror(dead): ${e.message}`));
  await dead.setViewportSize({ width: 1280, height: 800 });
  await dead.goto(`${s.base}/?mp=1`, { waitUntil: 'domcontentloaded' });
  await dead.waitForSelector('.tc-lobby', { timeout: 20000 });
  await dead.fill('#tc-relay', 'ws://127.0.0.1:5901');
  await dead.click('#tc-host');
  await sleep(1500);
  console.log('  dead relay says:',
    (await dead.textContent('#tc-note')).replace(/\s+/g, ' ').slice(0, 200));
  await shot(dead, '55-lobby-no-relay');

  // A code nobody opened, straight at the battle URL.
  const badc = await ctx.newPage();
  badc.on('pageerror', (e) => errs.push(`pageerror(badcode): ${e.message}`));
  await badc.setViewportSize({ width: 1280, height: 800 });
  await badc.goto(`${s.base}/?net=${encodeURIComponent(`ws://127.0.0.1:${RELAY}`)}&room=ZZZZZ&host=0`,
    { waitUntil: 'domcontentloaded' });
  await badc.waitForSelector('.tc-lobby h1', { timeout: 30000 });
  await sleep(400);
  console.log('  wrong code says:',
    (await badc.textContent('.tc-sheet')).replace(/\s+/g, ' ').slice(0, 220));
  await shot(badc, '56-wrong-code-refusal');

  // Nothing listening at all, straight at the battle URL.
  const norelay = await ctx.newPage();
  norelay.on('pageerror', (e) => errs.push(`pageerror(norelay): ${e.message}`));
  await norelay.setViewportSize({ width: 1280, height: 800 });
  await norelay.goto(`${s.base}/?net=${encodeURIComponent('ws://127.0.0.1:5901')}&room=RMEXQ&host=0`,
    { waitUntil: 'domcontentloaded' });
  await norelay.waitForSelector('.tc-lobby h1', { timeout: 30000 });
  await sleep(400);
  console.log('  no relay says:',
    (await norelay.textContent('.tc-sheet')).replace(/\s+/g, ' ').slice(0, 220));
  await shot(norelay, '57-no-relay-refusal');

  console.log(errs.length ? `\nERRORS:\n${errs.join('\n')}` : '\nno pageerror, no console.error');
} finally {
  await A.close();
  if (relay) relay.kill('SIGTERM');
  await s.close?.();
  if (s.server) s.server.kill('SIGTERM');
}
process.exit(errs.length ? 1 : 0);
