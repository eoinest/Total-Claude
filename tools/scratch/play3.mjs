#!/usr/bin/env node
/**
 * Scratch: play the lobby three ways with real clicks, and photograph each.
 *
 *   host      `npm run host` — a relay is there, the panel must not mention transport, and a
 *             match must start between two browsers.
 *   dev       `npm run dev` — vite's own binary, loopback, no relay. Must name `npm run host`.
 *   remote    `npm run dev -- --host` reached at the LAN address: an origin that has told the
 *             page nothing about itself, which is the deployed site's shape.
 *   live      https://total-claude.vercel.app — what a player sees today.
 *
 * Not a gate. `tools/qa-net.mjs` owns the assertions; this exists to produce frames and to be
 * driven by a person's eyes. Every process it starts is killed on the way out, including on a
 * throw: see `dying`.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { launchBrowser } from './../lib/browser-budget.mjs';
import { driveMenu } from './../lib/menu-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SHOTS = path.resolve(ROOT, process.argv[2] ?? 'screenshots/relay-invisible');
const HOST_PORT = 5948;
const HOST_RELAY = 5949;
const DEV_PORT = 5939;
const REMOTE_PORT = 5940;
const LIVE = 'https://total-claude.vercel.app';
const W = 1280;
const H = 800;

await mkdir(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `node_modules/vite/bin/vite.js`, found by walking up from whatever `vite` resolves to.
 *
 * Not joined onto `ROOT`: an agent worktree has no `node_modules` of its own and reaches the
 * main checkout's by resolution, so a path built from `ROOT` names a file that is not there.
 * Not `require.resolve('vite/bin/vite.js')` either — vite's `exports` map does not publish it.
 */
const VITE_BIN = (() => {
  let d = path.dirname(createRequire(import.meta.url).resolve('vite'));
  while (path.basename(d) !== 'vite' && d !== path.dirname(d)) d = path.dirname(d);
  return path.join(d, 'bin', 'vite.js');
})();

const kids = [];
const browsers = [];
let dying = false;
const reap = () => {
  if (dying) return;
  dying = true;
  for (const p of kids.splice(0)) {
    try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch { /* gone */ } }
  }
  for (const b of browsers.splice(0)) void b.close().catch(() => {});
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { reap(); process.exit(1); });
process.on('exit', reap);
process.on('uncaughtException', (e) => { console.error(e); reap(); process.exit(1); });

/**
 * `npm run dev`'s own binary, spawned without the npm/npx wrapper so the PID holds the port.
 *
 * Resolved rather than joined: an agent worktree has no `node_modules` of its own and reaches
 * the main checkout's by resolution, so a path built from `ROOT` names a file that is not there.
 * Its own `TC_VITE_CACHE_DIR` per port for the same reason — `vite.config.ts` spends a
 * paragraph on two servers sharing one optimiser cache through that symlink.
 */
const startDevServer = (port, extra = []) => {
  const p = spawn(process.execPath,
    [VITE_BIN,
      '--port', String(port), '--strictPort', ...extra],
    { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TC_NO_HMR: '1', TC_VITE_CACHE_DIR: `/tmp/tc-play3-${port}` } });
  kids.push(p);
  let out = '';
  p.stdout.on('data', (d) => { out += String(d); });
  p.stderr.on('data', (d) => { out += String(d); });
  return { proc: p, log: () => out };
};

const waitUp = async (url, ms = 90000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not yet */ }
    await sleep(300);
  }
  return false;
};

const errsOf = (page) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
  page.__errs = errs;
  return page;
};

/** What the panel is showing, in the terms this change is about. */
const lobbyState = (page) => page.evaluate(() => {
  const sheet = document.querySelector('.tc-sheet');
  const vis = (el) => !!el && !!el.getClientRects().length;
  const relay = document.querySelector('#tc-relay');
  const adv = document.querySelector('#tc-adv');
  const blocked = document.querySelector('#tc-no-relay');
  const text = (sheet?.innerText ?? '').replace(/\s+/g, ' ').trim();
  return {
    text,
    wsInVisibleText: /wss?:\/\//.test(text),
    relayFieldVisible: vis(relay),
    relayRect: relay ? (() => { const r = relay.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) }; })() : null,
    relayChecksVisible: relay?.checkVisibility?.() ?? null,
    relayHitTests: (() => {
      if (!relay) return null;
      const r = relay.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
      return !!el && (el === relay || relay.contains(el));
    })(),
    relayValue: relay ? relay.value : null,
    advPresent: !!adv,
    advOpen: !!adv?.open,
    blockedVisible: vis(blocked),
    blockedText: vis(blocked) ? (blocked.innerText ?? '').replace(/\s+/g, ' ').trim() : '',
    createDisabled: document.querySelector('#tc-host')?.disabled ?? null,
    joinDisabled: document.querySelector('#tc-join')?.disabled ?? null,
  };
});

const say = (tag, o) => {
  console.log(`\n--- ${tag} ---`);
  console.log(`  relay field visible : rects=${o.relayFieldVisible} check=${o.relayChecksVisible} `
    + `hit=${o.relayHitTests} rect=${JSON.stringify(o.relayRect)} value=${JSON.stringify(o.relayValue)}`);
  console.log(`  ws:// in view       : ${o.wsInVisibleText}`);
  console.log(`  advanced            : present=${o.advPresent} open=${o.advOpen}`);
  console.log(`  create/join disabled: ${o.createDisabled}/${o.joinDisabled}`);
  console.log(`  refusal             : ${o.blockedText.slice(0, 260) || '(none shown)'}`);
};

const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

const report = {};

const PHASES = (process.env.PHASES ?? 'host,refusals').split(',');

// ---------------------------------------------------------------------------
// 1. npm run host — two browsers, real clicks, a real match
// ---------------------------------------------------------------------------
if (PHASES.includes('host')) {
  const p = spawn('node', [path.join(ROOT, 'tools', 'host-lan.mjs'),
    `--port=${HOST_PORT}`, `--relay-port=${HOST_RELAY}`, '--json', '--no-open'],
  { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  kids.push(p);
  let out = '';
  p.stdout.on('data', (d) => { out += String(d); });
  let said = null;
  const end = Date.now() + 150000;
  while (Date.now() < end && !said) {
    const m = out.match(/^\{.*\}$/m);
    if (m) { try { said = JSON.parse(m[0]); } catch { /* half a line */ } }
    if (!said) await sleep(300);
  }
  if (!said) throw new Error(`host-lan said nothing: ${out.slice(0, 400)}`);
  console.log(`npm run host → ${said.lan} game ${said.gamePort} relay ${said.relayPort}`);
  const lanBase = `http://${said.lan}:${said.gamePort}`;
  if (!await waitUp(`${lanBase}/`)) throw new Error('host-lan game port never answered');

  const chrome = await launchBrowser({ label: 'play3-host', port: HOST_PORT, root: ROOT });
  browsers.push(chrome);
  const host = errsOf(await chrome.newPage({ viewport: { width: W, height: H } }));
  await host.goto(`${lanBase}/`, { waitUntil: 'domcontentloaded' });
  await host.waitForSelector('.menu.at-home .dest-multiplayer', { timeout: 60000 });
  await host.click('.menu-home .dest-multiplayer');
  await host.waitForSelector('.tc-lobby', { timeout: 30000 });
  await sleep(900);
  const st = await lobbyState(host);
  say('npm run host — the lobby', st);
  await shot(host, 'host-01-lobby');
  await host.click('#tc-adv-summary');
  await sleep(200);
  await shot(host, 'host-02-lobby-advanced-open');
  const advOpened = await lobbyState(host);
  await host.click('#tc-adv-summary');
  await sleep(200);

  const room = 'ROMEX'.replace(/O/g, 'Q');
  await host.click('#tc-room');
  await host.type('#tc-room', room, { delay: 25 });
  await host.click('#tc-host');
  await host.waitForSelector('#tc-code', { timeout: 20000 });
  await shot(host, 'host-03-room-open');
  const invite = ((await host.textContent('#tc-invite').catch(() => '')) ?? '').trim();
  console.log(`  invite: ${invite}`);
  await host.click('#tc-begin');
  await driveMenu(host, { map: 'campus-martius', scenario: 'field', tier: 'high', size: 'small' });

  const chrome2 = await launchBrowser({ label: 'play3-guest', port: HOST_PORT + 1, root: ROOT });
  browsers.push(chrome2);
  const guest = errsOf(await chrome2.newPage({ viewport: { width: W, height: H } }));
  await guest.goto(`${lanBase}/`, { waitUntil: 'domcontentloaded' });
  await guest.waitForSelector('.menu.at-home .dest-multiplayer', { timeout: 60000 });
  await guest.click('.menu-home .dest-multiplayer');
  await guest.waitForSelector('.tc-lobby', { timeout: 30000 });
  await sleep(700);
  await shot(guest, 'host-04-guest-lobby');
  const guestState = await lobbyState(guest);
  say('npm run host — the challenger\'s lobby', guestState);
  await guest.click('#tc-room');
  await guest.type('#tc-room', room, { delay: 25 });
  await guest.click('#tc-join');
  const ready = await guest.waitForFunction(() => window.__game?.ready === true, null,
    { timeout: 300000 }).then(() => true).catch(() => false);
  await sleep(2500);
  await shot(guest, 'host-05-guest-in-battle');
  await shot(host, 'host-06-host-in-battle');
  const both = await Promise.all([host, guest].map((pg) => pg.evaluate(() =>
    (window.__game?.net ? window.__game.net.status() : null))));
  console.log(`  match: ready=${ready} host=${JSON.stringify(both[0])} guest=${JSON.stringify(both[1])}`);
  report.host = { st, advOpened, guestState, ready, both, invite,
    errs: [...host.__errs, ...guest.__errs] };
  await host.close(); await guest.close();
  await chrome2.close(); browsers.splice(browsers.indexOf(chrome2), 1);
  await chrome.close(); browsers.splice(browsers.indexOf(chrome), 1);
  try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ }
  kids.splice(kids.indexOf(p), 1);
}

// ---------------------------------------------------------------------------
// 2 & 3. npm run dev, loopback and --host. 4. the live site.
// ---------------------------------------------------------------------------
if (PHASES.includes('refusals')) {
  const dev = startDevServer(DEV_PORT);
  const remote = startDevServer(REMOTE_PORT, ['--host']);
  if (!await waitUp(`http://127.0.0.1:${DEV_PORT}/`)) throw new Error(`dev never came up: ${dev.log()}`);
  if (!await waitUp(`http://127.0.0.1:${REMOTE_PORT}/`)) throw new Error(`remote never came up: ${remote.log()}`);
  const lan = (await import('./../lib/lan-address.mjs')).lanAddress({});
  if (!lan) throw new Error('no LAN address to reach the --host server at');

  const chrome = await launchBrowser({ label: 'play3-refusals', port: DEV_PORT, root: ROOT });
  browsers.push(chrome);

  for (const [tag, url, file] of [
    ['npm run dev', `http://127.0.0.1:${DEV_PORT}/`, 'dev'],
    ['npm run dev -- --host, at the LAN address (the deployed shape)', `http://${lan.ip}:${REMOTE_PORT}/`, 'remote'],
    [`the live site ${LIVE}`, `${LIVE}/`, 'live'],
  ]) {
    const page = errsOf(await chrome.newPage({ viewport: { width: W, height: H } }));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForSelector('.menu.at-home .dest-multiplayer', { timeout: 120000 });
    await page.click('.menu-home .dest-multiplayer');
    await page.waitForSelector('.tc-lobby', { timeout: 30000 });
    await sleep(1500);
    const st = await lobbyState(page);
    say(tag, st);
    await shot(page, `${file}-01-lobby`);
    report[file] = { url, st, errs: page.__errs.slice(0, 6) };
    await page.close();
  }
  await chrome.close(); browsers.splice(browsers.indexOf(chrome), 1);
}

console.log(`\nframes in ${SHOTS}`);
console.log(JSON.stringify(report, null, 2).slice(0, 6000));
reap();
process.exit(0);
