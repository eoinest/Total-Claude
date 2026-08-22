#!/usr/bin/env node
/** Scratch: boot one relayed host page and say what is actually on it. */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { bootThroughMenu, waitForServer } from '../lib/menu-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PORT = Number(process.argv[2] ?? 5937);
const RELAY = Number(process.argv[3] ?? 5968);
const base = `http://127.0.0.1:${PORT}`;

const relay = spawn('node', [path.join(ROOT, 'tools', 'relay.mjs'), `--port=${RELAY}`],
  { cwd: ROOT, stdio: 'inherit' });
await waitForServer(`http://127.0.0.1:${RELAY}/health`, 15000);

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => console.log(`console.${m.type()}:`, m.text().slice(0, 300)));

const q = `net=${encodeURIComponent(`ws://127.0.0.1:${RELAY}`)}&room=PEEKA&autoplay=0&deploy=1`;
await bootThroughMenu(page, { base, map: 'campus-martius', scenario: 'field', tier: 'high', size: 'small', query: q });
const guest = await b.newPage({ viewport: { width: 1280, height: 800 } });
guest.on('pageerror', (e) => console.log('GUEST PAGEERROR', e.message));
guest.on('console', (m) => { if (m.type() === 'error') console.log('GUEST console.error:', m.text().slice(0, 300)); });
await guest.goto(`${base}/?${q}&host=0`, { waitUntil: 'domcontentloaded' });
await guest.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await page.waitForTimeout(2500);
const dump = () => {
  const g = window.__game;
  const ctx = g.engine.context;
  const dep = ctx.tryGet('deployment');
  const depB = ctx.tryGet('deployment-peer');
  return {
    net: g.net ? g.net.status() : null,
    hudRootClasses: document.querySelector('.hud')?.className ?? '(no .hud)',
    depAdd: !!document.querySelector('.dep-add'),
    depRows: document.querySelectorAll('.dep-row').length,
    dep: dep ? { active: dep.active, committed: dep.committed, faction: dep.playerFaction, own: dep.ownUnits().length, roster: dep.roster().length } : null,
    depB: depB ? { active: depB.active, faction: depB.playerFaction, own: depB.ownUnits().length } : null,
    paused: ctx.time.paused,
    tick: ctx.time.tick,
    systems: g.engine.systems ? g.engine.systems.map((s) => s.name) : '(no systems array)',
  };
};
console.log('HOST', JSON.stringify(await page.evaluate(dump), null, 2));
console.log('GUEST', JSON.stringify(await guest.evaluate(dump), null, 2));
await page.screenshot({ path: '/tmp/net-peek-host.png' });
await guest.screenshot({ path: '/tmp/net-peek-guest.png' });
await b.close();
relay.kill('SIGTERM');
