#!/usr/bin/env node
/**
 * Play the two-commanders flow and photograph every step.
 *
 * The lobby's controls cannot be reached by a real mouse (see tools/scratch/probe-lobby.mjs),
 * so this drives them with `el.click()` from inside the page — which bypasses both the
 * pointer-events wall and the off-viewport geometry — in order to find out whether anything
 * *downstream* of the form works. Exploration only.
 */
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { launchBrowser } from '../lib/browser-budget.mjs';
import { ensureServer } from '../lib/menu-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PORT = 5941;
const RELAY = 5977;
const SHOTS = path.join(ROOT, 'screenshots', 'two-commanders');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const relays = [];
const browsers = [];
let server = null;
function cleanup() {
  for (const p of relays.splice(0)) { try { p.kill('SIGTERM'); } catch { /* gone */ } }
  for (const b of browsers.splice(0)) { void b.close().catch(() => {}); }
  if (server) server.kill('SIGTERM');
}
const die = (e) => { console.error(e); cleanup(); process.exit(1); };
process.on('uncaughtException', die);
process.on('unhandledRejection', die);

async function startRelay(port, extra = []) {
  const p = spawn('node', [path.join(ROOT, 'tools', 'relay.mjs'), `--port=${port}`,
    `--parent=${process.pid}`, ...extra], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  relays.push(p);
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const body = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.text()).catch(() => '');
    if (body.startsWith('relay ok')) return { base: `ws://127.0.0.1:${port}`, proc: p };
    await sleep(200);
  }
  throw new Error(`relay did not start on ${port}`);
}

await mkdir(SHOTS, { recursive: true });
const s = await ensureServer({ port: PORT, root: ROOT, cacheDir: path.join(ROOT, '.vite-cache', `play-${PORT}`) });
server = s.server;
const base = s.base;
console.log(`server ${base}`);
const relay = await startRelay(RELAY);
console.log(`relay ${relay.base}`);

const A = await launchBrowser({ label: 'play-lobby/host', engine: 'chromium', args: ['--hide-scrollbars'], port: PORT, root: ROOT });
browsers.push(A);
const B = await launchBrowser({ label: 'play-lobby/guest', engine: 'chromium', args: ['--hide-scrollbars'], port: PORT, root: ROOT });
browsers.push(B);

const newPage = async (br) => {
  const ctx = await br.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.__errs = [];
  page.on('pageerror', (e) => page.__errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') page.__errs.push(`console.error: ${m.text()}`); });
  return page;
};
let n = 0;
const shot = async (page, name, full = false) => {
  const f = path.join(SHOTS, `${String(++n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: f, fullPage: full });
  console.log(`  shot ${path.basename(f)}`);
};
/** Type into a field the mouse cannot reach. */
const setField = (page, sel, v) => page.$eval(sel, (el, val) => {
  el.focus(); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true }));
  for (const c of val) { el.value += c; el.dispatchEvent(new Event('input', { bubbles: true })); }
}, v);
const jsClick = (page, sel) => page.$eval(sel, (el) => el.click());
const note = (page) => page.$eval('#tc-note', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '(no note element)');
const bodyText = async (page) => (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').trim().slice(0, 320);

// ---------------------------------------------------------------------------
console.log('\n=== A. the host types a room code and presses CREATE A ROOM ===');
const host = await newPage(A);
await host.goto(`${base}/?mp=1`, { waitUntil: 'domcontentloaded' });
await host.waitForSelector('.tc-lobby');
await sleep(400);
await setField(host, '#tc-relay', relay.base);
await setField(host, '#tc-room', 'ROMEX');
console.log('  typed into #tc-room:', await host.$eval('#tc-room', (e) => e.value));
await shot(host, 'A1-typed-code', true);
await jsClick(host, '#tc-host');
await sleep(250);
console.log('  note @250ms:', JSON.stringify(await note(host)));
await shot(host, 'A2-create-pressed', true);
await sleep(500);
console.log('  note @750ms:', JSON.stringify(await note(host)));
await shot(host, 'A3-invite-shown', true);
// the invite is on screen for 900ms and then the page navigates
await host.waitForFunction(() => !document.querySelector('.tc-lobby'), null, { timeout: 15000 }).catch(() => {});
await sleep(300);
console.log('  url after create:', host.url());
const roomUsed = new URL(host.url()).searchParams.get('room');
console.log(`  >>> player typed ROMEX; the room actually created is ${roomUsed}`);
await shot(host, 'A4-after-navigate');
await sleep(1500);
await shot(host, 'A5-host-setup-sheet');
console.log('  host body:', await bodyText(host));
console.log('  does anything on the host name the room?', await host.evaluate(() =>
  document.body.innerText.split('\n').filter((l) => /room|invite|code|opponent|challenger|waiting|join/i.test(l))));
console.log('  clipboard readable?', await host.evaluate(() => (navigator.clipboard ? 'clipboard object exists' : 'NO navigator.clipboard')));

console.log('\n=== B. the host presses BEGIN BATTLE with nobody in the room ===');
await host.waitForSelector('.menu-sheet', { timeout: 60000 });
await host.click('.menu [data-map="campus-martius"]').catch(() => {});
await host.click('.menu [data-scen="field"]').catch(() => {});
await host.click('.menu [data-size="small"]').catch(() => {});
await sleep(300);
await shot(host, 'B1-setup-sheet');
await host.click('.menu .begin');
console.log('  waiting for the host engine…');
await host.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await sleep(2500);
await shot(host, 'B2-host-in-battle-alone');
console.log('  host net status:', JSON.stringify(await host.evaluate(() => window.__game?.net?.status() ?? null)));
console.log('  host strip text:', await host.$eval('.tc-net', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '(no .tc-net)'));
console.log('  host body:', await bodyText(host));

console.log('\n=== C. the challenger types the SAME code and presses JOIN ===');
const guest = await newPage(B);
await guest.goto(`${base}/?mp=1`, { waitUntil: 'domcontentloaded' });
await guest.waitForSelector('.tc-lobby');
await setField(guest, '#tc-relay', relay.base);
await setField(guest, '#tc-room', roomUsed);
await shot(guest, 'C1-guest-typed-code', true);
await jsClick(guest, '#tc-join');
await sleep(1200);
console.log('  guest url:', guest.url());
await shot(guest, 'C2-guest-joining');
console.log('  guest body:', await bodyText(guest));
await guest.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 }).catch((e) => console.log('  guest never became ready:', String(e).split('\n')[0]));
await sleep(2500);
await shot(guest, 'C3-guest-ready');
console.log('  guest net status:', JSON.stringify(await guest.evaluate(() => window.__game?.net?.status() ?? null)));
await shot(host, 'C4-host-when-peer-arrives');
console.log('  host net status:', JSON.stringify(await host.evaluate(() => window.__game?.net?.status() ?? null)));

console.log('\n=== D. both deploy and fight ===');
for (const [p, tag] of [[host, 'host'], [guest, 'guest']]) {
  const d = await p.evaluate(() => (window.__game?.deployment ? { active: window.__game.deployment.active } : null));
  console.log(`  ${tag} deployment:`, JSON.stringify(d));
}
for (const [p, tag] of [[host, 'host'], [guest, 'guest']]) {
  const has = await p.$('.dep-add');
  if (!has) { console.log(`  ${tag}: no .dep-add`); continue; }
  const rows = await p.$$('.dep-add');
  for (const r of rows) { if (await r.isEnabled()) { await r.click(); break; } }
  await sleep(400);
  await shot(p, `D-${tag}-deployed`);
  const begin = await p.$('.dep-begin');
  if (begin && await begin.isEnabled()) await begin.click();
}
for (let i = 0; i < 14; i++) {
  await sleep(5000);
  const hs = await host.evaluate(() => window.__game?.net?.status() ?? null).catch(() => null);
  const gs = await guest.evaluate(() => window.__game?.net?.status() ?? null).catch(() => null);
  console.log(`  t+${(i + 1) * 5}s host=${JSON.stringify(hs && { ph: hs.phase, peer: hs.peer, turn: hs.turn, ended: hs.ended })} guest=${JSON.stringify(gs && { ph: gs.phase, peer: gs.peer, turn: gs.turn, ended: gs.ended })}`);
  if (hs?.phase === 'battle' && hs.turn > 60) break;
}
await shot(host, 'D1-host-battle');
await shot(guest, 'D2-guest-battle');

console.log('\n=== E. the peer leaves mid-battle ===');
await guest.context().close();
await sleep(4000);
await shot(host, 'E1-host-after-peer-left');
console.log('  host net status:', JSON.stringify(await host.evaluate(() => window.__game?.net?.status() ?? null)));
console.log('  host strip:', await host.$eval('.tc-net', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '(none)'));

console.log('\n  host page errors:', host.__errs.slice(0, 8));
cleanup();
console.log('\ndone. shots in', SHOTS);
process.exit(0);
