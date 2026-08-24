#!/usr/bin/env node
/**
 * Play everything downstream of the lobby form, by building the URL the form would have
 * built — because the form's Create button cannot reach the relay from a browser at all.
 * Exploration only.
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

const relays = []; const browsers = []; let server = null;
function cleanup() {
  for (const p of relays.splice(0)) { try { p.kill('SIGTERM'); } catch { /* gone */ } }
  for (const b of browsers.splice(0)) { void b.close().catch(() => {}); }
  if (server) server.kill('SIGTERM');
}
const die = (e) => { console.error(e); cleanup(); process.exit(1); };
process.on('uncaughtException', die);
process.on('unhandledRejection', die);

async function startRelay(port) {
  const p = spawn('node', [path.join(ROOT, 'tools', 'relay.mjs'), `--port=${port}`,
    `--parent=${process.pid}`], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  relays.push(p);
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const body = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.text()).catch(() => '');
    if (body.startsWith('relay ok')) return { base: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}` };
    await sleep(200);
  }
  throw new Error(`relay did not start on ${port}`);
}

await mkdir(SHOTS, { recursive: true });
const s = await ensureServer({ port: PORT, root: ROOT, cacheDir: path.join(ROOT, '.vite-cache', `play-${PORT}`) });
server = s.server; const base = s.base;
const relay = await startRelay(RELAY);
console.log(`server ${base}  relay ${relay.base}`);

const A = await launchBrowser({ label: 'play-flow/host', engine: 'chromium', args: ['--hide-scrollbars'], port: PORT, root: ROOT });
browsers.push(A);
const B = await launchBrowser({ label: 'play-flow/guest', engine: 'chromium', args: ['--hide-scrollbars'], port: PORT, root: ROOT });
browsers.push(B);

const newPage = async (br) => {
  const ctx = await br.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.__errs = [];
  page.on('pageerror', (e) => page.__errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') page.__errs.push(`console.error: ${m.text()}`); });
  return page;
};
let n = 20;
const shot = async (page, name) => {
  const f = path.join(SHOTS, `${String(++n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: f });
  console.log(`  shot ${path.basename(f)}`);
};
const txt = async (page) => (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').trim().slice(0, 300);
const netOf = (page) => page.evaluate(() => window.__game?.net?.status() ?? null).catch(() => null);

const ROOM = await fetch(`${relay.http}/new`).then((r) => r.json()).then((j) => j.room);
console.log(`room ${ROOM} (made by hand — the button cannot)`);
const q = `net=${encodeURIComponent(relay.base)}&room=${ROOM}&autoplay=0&deploy=1`;

// ---------------------------------------------------------------------------
console.log('\n=== A. the host, alone in the room, from the URL the lobby builds ===');
const host = await newPage(A);
await host.goto(`${base}/?${q}&menu=battle`, { waitUntil: 'domcontentloaded' });
await host.waitForSelector('.menu.at-setup .begin', { timeout: 60000 });
await sleep(700);
await shot(host, 'F1-host-setup-sheet');
console.log('  does the setup sheet mention the room, the relay or the opponent?');
console.log('   ', (await host.evaluate(() => document.body.innerText)).split('\n').filter((l) => /room|relay|opponent|challenger|multiplayer|commander|invite|wait/i.test(l)).slice(0, 8));
await host.click('.menu [data-map="campus-martius"]').catch(() => {});
await host.click('.menu [data-scen="field"]').catch(() => {});
await host.click('.menu [data-size="small"]').catch(() => {});
await sleep(300);
await host.click('.menu .begin');
console.log('  BEGIN pressed with nobody in the room; loading…');
const t0 = Date.now();
await host.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
console.log(`  host ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await sleep(3000);
await shot(host, 'F2-host-alone-in-room');
console.log('  host net:', JSON.stringify(await netOf(host)));
console.log('  host strip:', await host.$eval('.tc-net', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '(no strip)'));
console.log('  host body:', await txt(host));
console.log('  is the sim advancing while it waits? tick =',
  await host.evaluate(() => window.__game?.engine?.time?.tick));
await sleep(6000);
console.log('  tick 6s later =', await host.evaluate(() => window.__game?.engine?.time?.tick));
await shot(host, 'F3-host-alone-6s-later');
console.log('  can the host see how to invite anybody? searching the DOM for the code…');
console.log('   ', await host.evaluate((code) => {
  const hits = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length === 0 && el.textContent.includes(code)) hits.push(`${el.tagName}.${el.className}: ${el.textContent.trim().slice(0, 80)}`);
  }
  return hits.slice(0, 5);
}, ROOM));

// ---------------------------------------------------------------------------
console.log('\n=== B. the challenger arrives ===');
const guest = await newPage(B);
await guest.goto(`${base}/?${q}&host=0`, { waitUntil: 'domcontentloaded' });
await sleep(1500);
await shot(guest, 'F4-guest-loading');
console.log('  guest body while loading:', await txt(guest));
await guest.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await sleep(3000);
await shot(guest, 'F5-guest-ready');
await shot(host, 'F6-host-when-peer-arrives');
console.log('  host net: ', JSON.stringify(await netOf(host)));
console.log('  guest net:', JSON.stringify(await netOf(guest)));
console.log('  host strip: ', await host.$eval('.tc-net', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '(none)'));
console.log('  guest strip:', await guest.$eval('.tc-net', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '(none)'));

// ---------------------------------------------------------------------------
console.log('\n=== C. both deploy, then fight ===');
for (const [p, tag] of [[host, 'host'], [guest, 'guest']]) {
  await p.waitForSelector('.dep-add', { timeout: 30000 }).catch(() => console.log(`  ${tag}: no .dep-add`));
  const rows = await p.$$('.dep-add');
  let placed = 0;
  for (const r of rows) { if (await r.isEnabled()) { await r.click(); placed++; if (placed >= 2) break; } }
  await sleep(500);
  await shot(p, `F-${tag}-deploying`);
  console.log(`  ${tag}: placed ${placed}`);
}
for (const [p, tag] of [[host, 'host'], [guest, 'guest']]) {
  const b = await p.$('.dep-begin');
  if (b && await b.isEnabled()) { await b.click(); console.log(`  ${tag}: BEGIN pressed`); }
  else console.log(`  ${tag}: .dep-begin ${b ? 'disabled' : 'missing'}`);
}
for (let i = 0; i < 12; i++) {
  await sleep(5000);
  const hs = await netOf(host); const gs = await netOf(guest);
  console.log(`  t+${(i + 1) * 5}s host=${JSON.stringify(hs && { ph: hs.phase, peer: hs.peer, turn: hs.turn, ended: hs.ended })} guest=${JSON.stringify(gs && { ph: gs.phase, peer: gs.peer, turn: gs.turn, ended: gs.ended })}`);
  if (hs?.phase === 'battle' && hs.turn > 80) break;
}
await shot(host, 'F7-host-battle');
await shot(guest, 'F8-guest-battle');
console.log('  host strip:', await host.$eval('.tc-net', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '(none)'));

// ---------------------------------------------------------------------------
console.log('\n=== D. the challenger closes the window mid-battle ===');
await guest.context().close();
await sleep(5000);
await shot(host, 'F9-host-after-peer-left');
console.log('  host net:', JSON.stringify(await netOf(host)));
console.log('  host strip:', await host.$eval('.tc-net', (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '(none)'));
await sleep(8000);
await shot(host, 'F10-host-13s-after-peer-left');
console.log('  host net 13s later:', JSON.stringify(await netOf(host)));
console.log('  host: is anything offering a way out?',
  await host.evaluate(() => [...document.querySelectorAll('button,a')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 12)));
await host.context().close();

// ---------------------------------------------------------------------------
console.log('\n=== E. joining a room nobody made (a mistyped code) ===');
const g1 = await newPage(B);
await g1.goto(`${base}/?net=${encodeURIComponent(relay.base)}&room=ZZZZZ&host=0`, { waitUntil: 'domcontentloaded' });
await sleep(3000);
await shot(g1, 'F11-ghost-room-3s');
console.log('  body @3s:', await txt(g1));
await sleep(20000);
await shot(g1, 'F12-ghost-room-23s');
console.log('  body @23s:', await txt(g1));
console.log('  errors:', g1.__errs.slice(0, 4));
console.log('  relay rooms:', await fetch(`${relay.http}/status`).then((r) => r.json()).then((j) => j.rooms.map((r) => `${r.code ?? '?'} occ=${r.occupied} phase=${r.phase}`)));
await g1.context().close();

console.log('\n=== F. joining a relay that is not there ===');
const g2 = await newPage(B);
await g2.goto(`${base}/?net=${encodeURIComponent('ws://127.0.0.1:5903')}&room=ABCDE&host=0`, { waitUntil: 'domcontentloaded' });
await sleep(4000);
await shot(g2, 'F13-dead-relay-4s');
console.log('  body @4s:', await txt(g2));
await sleep(15000);
await shot(g2, 'F14-dead-relay-19s');
console.log('  body @19s:', await txt(g2));
console.log('  errors:', g2.__errs.slice(0, 4));
console.log('  anything to click?', await g2.evaluate(() => [...document.querySelectorAll('button,a')].map((e) => e.textContent.trim()).filter(Boolean).slice(0, 8)));
await g2.context().close();

cleanup();
console.log('\ndone.');
process.exit(0);
