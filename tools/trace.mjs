#!/usr/bin/env node
/**
 * Battle trace. Fast-forwards the simulation and logs army state at intervals, so we
 * can tell whether a battle actually *happens* — advances, clashes, breaks, resolves —
 * rather than two armies standing politely at opposite ends of the field.
 *
 * Usage: node tools/trace.mjs [--port=5250] [--until=300] [--every=15]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5250);
const UNTIL = Number(args.get('until') ?? 300);
const EVERY = Number(args.get('every') ?? 15);

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1000))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 60000))) {
    console.error('vite did not start');
    process.exit(1);
  }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${base}/?harness=1&quality=high&w=960&h=540`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 120000 });

const ORDER = ['Hold', 'MoveTo', 'AttackMove', 'AttackUnit', 'Withdraw', 'Rout', 'Garrison'];

const snap = async () =>
  page.evaluate(() => {
    const g = window.__game;
    const b = g.battle;
    const out = { t: Math.round(g.simTime()), rome: 0, germ: 0, corpses: 0, engaged: 0, routing: 0, units: [] };
    const p = b.pool;
    for (let i = 0; i < p.count; i++) {
      const s = p.state[i];
      if (s === 10 || s === 11) out.corpses++;
      if (s === 4) out.engaged++;
      if (s === 12) out.routing++;
    }
    for (const u of b.units) {
      if (u.faction === 0) out.rome += u.alive; else out.germ += u.alive;
      out.units.push({
        id: u.id, type: u.typeId, fac: u.faction, alive: u.alive,
        x: Math.round(u.x), z: Math.round(u.z),
        order: u.order, mor: Math.round(u.morale), eng: u.engaged, dead: u.destroyed,
      });
    }
    return out;
  });

console.log('  t   ROME  GERM  corpses  engaged  routing   | notable unit positions');
console.log('-'.repeat(104));

let last = null;
for (let t = 0; t <= UNTIL; t += EVERY) {
  await page.evaluate((target) => {
    const g = window.__game;
    const need = target - g.simTime();
    if (need > 0) g.advance(need);
  }, t);
  const s = await snap();
  const live = s.units.filter((u) => !u.dead);
  // Show the two closest opposing units so we can see whether the gap is closing.
  const rome = live.filter((u) => u.fac === 0);
  const germ = live.filter((u) => u.fac === 1);
  let gap = Infinity;
  for (const a of rome) for (const c of germ) {
    const d = Math.hypot(a.x - c.x, a.z - c.z);
    if (d < gap) gap = d;
  }
  const orders = {};
  for (const u of live) orders[ORDER[u.order] ?? u.order] = (orders[ORDER[u.order] ?? u.order] ?? 0) + 1;
  console.log(
    `${String(s.t).padStart(4)}  ${String(s.rome).padStart(4)}  ${String(s.germ).padStart(4)}  ` +
    `${String(s.corpses).padStart(7)}  ${String(s.engaged).padStart(7)}  ${String(s.routing).padStart(7)}   | ` +
    `gap ${gap === Infinity ? '--' : Math.round(gap) + 'm'}  ` +
    Object.entries(orders).map(([k, v]) => `${k}:${v}`).join(' ')
  );
  last = s;
}

if (last) {
  console.log('\nfinal per-unit state:');
  for (const u of last.units) {
    console.log(
      `  ${String(u.id).padStart(2)} ${u.type.padEnd(22)} ${u.fac === 0 ? 'ROME' : 'GERM'} ` +
      `alive ${String(u.alive).padStart(3)}  pos (${String(u.x).padStart(5)},${String(u.z).padStart(5)})  ` +
      `${(ORDER[u.order] ?? u.order).padEnd(10)} morale ${String(u.mor).padStart(3)}` +
      `${u.eng ? '  ENGAGED' : ''}${u.dead ? '  DESTROYED' : ''}`
    );
  }
}

if (errors.length) {
  console.log(`\n${errors.length} console error(s):`);
  for (const e of [...new Set(errors)].slice(0, 15)) console.log(`  ${e}`);
}

await browser.close();
if (server) server.kill('SIGTERM');
process.exit(errors.length ? 1 : 0);
