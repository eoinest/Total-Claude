#!/usr/bin/env node
/**
 * Gameplay probe.
 *
 * `trace.mjs` answers "did a battle happen". This answers "is the battle any good":
 *   - soldier state histogram over time (are men actually Fighting, and do they stay
 *     Fighting, or flicker between Fighting and Marching?)
 *   - per-unit contact signals from the combat blackboard (contactLock, engagedFraction)
 *   - unit yaw rate and anchor drift while in contact — the fingerprint of a spiral
 *   - the morale pressure breakdown for whoever is closest to breaking
 *   - measured per-system fixedUpdate cost in milliseconds
 *
 * Usage:
 *   node tools/gp.mjs --port=5361 --until=400 --every=20 [--autoplay=0] [--flicker]
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
const PORT = Number(args.get('port') ?? 5361);
const UNTIL = Number(args.get('until') ?? 400);
const EVERY = Number(args.get('every') ?? 20);
const AUTOPLAY = args.get('autoplay') ?? '1';
const QUALITY = args.get('quality') ?? 'high';

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
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${base}/?harness=1&quality=${QUALITY}&autoplay=${AUTOPLAY}&w=640&h=360`, {
  waitUntil: 'domcontentloaded',
});
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 120000 });

// Instrument the simulation systems in place: wrap fixedUpdate with a timer, and keep a
// per-tick history of Fighting-state transitions so flicker is measurable.
await page.evaluate(() => {
  const g = window.__game;
  const ctx = g.engine.context;
  const w = {};
  window.__probe = {
    ms: {}, ticks: 0,
    enter: 0, leave: 0, fightTicks: 0,
    yaw: new Map(), yawRate: new Map(), anchor: new Map(), anchorRate: new Map(),
  };
  const P = window.__probe;
  for (const name of ['battle', 'combat', 'morale', 'projectiles', 'abilities',
    'pathfinding', 'tactical-ai', 'general-ai', 'autoEngage', 'battleFlow', 'ragdoll']) {
    const s = ctx.tryGet(name);
    if (!s || !s.fixedUpdate) continue;
    const orig = s.fixedUpdate.bind(s);
    P.ms[name] = 0;
    s.fixedUpdate = (dt, c) => {
      const t = performance.now();
      orig(dt, c);
      P.ms[name] += performance.now() - t;
    };
  }
  // Sample after the whole sim has run: hook the last system in the sim band.
  const flow = ctx.tryGet('battleFlow');
  if (flow) {
    const orig = flow.fixedUpdate.bind(flow);
    const prev = new Uint8Array(g.battle.pool.capacity);
    flow.fixedUpdate = (dt, c) => {
      orig(dt, c);
      const p = g.battle.pool;
      P.ticks++;
      for (let i = 0; i < p.count; i++) {
        const now = p.state[i] === 4 ? 1 : 0;
        if (now) P.fightTicks++;
        if (now !== prev[i]) { if (now) P.enter++; else P.leave++; }
        prev[i] = now;
      }
      for (const u of g.battle.units) {
        if (u.destroyed) continue;
        const y0 = P.yaw.get(u.id);
        if (y0 !== undefined) {
          let d = u.facing - y0;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          P.yawRate.set(u.id, (P.yawRate.get(u.id) ?? 0) + Math.abs(d));
        }
        P.yaw.set(u.id, u.facing);
        const a0 = P.anchor.get(u.id);
        if (a0) P.anchorRate.set(u.id, (P.anchorRate.get(u.id) ?? 0) + Math.hypot(u.x - a0[0], u.z - a0[1]));
        P.anchor.set(u.id, [u.x, u.z]);
      }
    };
  }
  void w;
});

const STATE = ['Idle', 'March', 'Run', 'Charge', 'FIGHT', 'Brace', 'Throw', 'Shoot',
  'Reload', 'Stagger', 'Dying', 'Dead', 'ROUT', 'Climb', 'Cheer'];
const ORDER = ['Hold', 'MoveTo', 'AttackMove', 'AttackUnit', 'Withdraw', 'Rout', 'Garrison'];

const snap = async () =>
  page.evaluate(() => {
    const g = window.__game;
    const b = g.battle;
    const P = window.__probe;
    const ctx = g.engine.context;
    const combat = ctx.tryGet('combat');
    const morale = ctx.tryGet('morale');
    const p = b.pool;
    const hist = new Array(15).fill(0);
    let movingWhileFighting = 0;
    for (let i = 0; i < p.count; i++) {
      const s = p.state[i];
      hist[s]++;
      if (s === 4 && Math.hypot(p.vx[i], p.vz[i]) > 0.6) movingWhileFighting++;
    }
    const units = [];
    let rome = 0; let germ = 0;
    for (const u of b.units) {
      if (u.faction === 0) rome += u.alive; else germ += u.alive;
      if (u.destroyed) continue;
      const sig = window.__sig ? window.__sig(u.id) : null;
      units.push({
        id: u.id, type: u.typeId, fac: u.faction, alive: u.alive, init: u.initialStrength,
        x: Math.round(u.x), z: Math.round(u.z), order: u.order,
        mor: Math.round(u.morale), maxMor: u.maxMorale, eng: u.engaged,
        lock: sig ? sig.contactLock : null,
        engf: sig ? Math.round(sig.engagedFraction * 100) / 100 : null,
        push: sig ? Math.round(sig.pushBalance * 100) / 100 : null,
        yawDeg: Math.round((P.yawRate.get(u.id) ?? 0) * 180 / Math.PI),
        drift: Math.round(P.anchorRate.get(u.id) ?? 0),
        terms: morale?.moraleTerms ? morale.moraleTerms(u.id) : null,
      });
      P.yawRate.set(u.id, 0);
      P.anchorRate.set(u.id, 0);
    }
    const ms = {};
    for (const k of Object.keys(P.ms)) {
      ms[k] = Math.round((P.ms[k] / Math.max(1, P.ticks)) * 1000) / 1000;
      P.ms[k] = 0;
    }
    const flick = { enter: P.enter, leave: P.leave, ticks: P.ticks, fightTicks: P.fightTicks };
    P.enter = 0; P.leave = 0; P.ticks = 0; P.fightTicks = 0;
    return {
      t: Math.round(g.simTime()), rome, germ, hist, units, ms, flick, movingWhileFighting,
      combatMs: combat?.lastCostMs ?? 0,
    };
  });

// Expose `signalsOf` so the probe can read the combat blackboard.
await page.evaluate(async () => {
  const mod = await import('/src/sim/combatShared.ts');
  window.__sig = mod.signalsOf;
});

console.log(`# gameplay probe  autoplay=${AUTOPLAY} quality=${QUALITY}`);
console.log('   t  ROME  GERM | FIGHT  ROUT  Dead  Idle March Charge Brace | mvFight  eF>0  lock  yaw/s  ms(sim)');
console.log('-'.repeat(118));

const rows = [];
for (let t = 0; t <= UNTIL; t += EVERY) {
  await page.evaluate((target) => {
    const g = window.__game;
    const need = target - g.simTime();
    if (need > 0) g.advance(need);
  }, t);
  const s = await snap();
  rows.push(s);
  const inContact = s.units.filter((u) => u.lock).length;
  const engagedUnits = s.units.filter((u) => (u.engf ?? 0) > 0.02).length;
  const yaw = s.units.filter((u) => u.lock).reduce((a, u) => a + u.yawDeg, 0);
  const simMs = Object.entries(s.ms)
    .filter(([k]) => k !== 'ragdoll')
    .reduce((a, [, v]) => a + v, 0);
  console.log(
    `${String(s.t).padStart(4)} ${String(s.rome).padStart(5)} ${String(s.germ).padStart(5)} |` +
    `${String(s.hist[4]).padStart(6)}${String(s.hist[12]).padStart(6)}${String(s.hist[11]).padStart(6)}` +
    `${String(s.hist[0]).padStart(6)}${String(s.hist[1]).padStart(6)}${String(s.hist[3]).padStart(7)}` +
    `${String(s.hist[5]).padStart(6)} |${String(s.movingWhileFighting).padStart(8)}` +
    `${String(engagedUnits).padStart(6)}${String(inContact).padStart(6)}` +
    `${String(Math.round(yaw / Math.max(1, inContact) / EVERY)).padStart(7)}` +
    `${String(Math.round(simMs * 100) / 100).padStart(9)}`
  );
}

const last = rows[rows.length - 1];
console.log('\nper-system fixedUpdate ms (mean over last window):');
for (const [k, v] of Object.entries(last.ms)) console.log(`  ${k.padEnd(14)} ${v}`);

console.log('\nFighting-state flicker over the last window:');
console.log(`  ticks ${last.flick.ticks}  entries ${last.flick.enter}  exits ${last.flick.leave}` +
  `  mean men fighting ${Math.round(last.flick.fightTicks / Math.max(1, last.flick.ticks))}`);
console.log(`  churn = ${(last.flick.enter / Math.max(1, last.flick.fightTicks / last.flick.ticks) / last.flick.ticks).toFixed(3)}` +
  ' entries per fighting-man per tick (0 = perfectly stable lock-up)');

console.log('\nfinal per-unit state:');
for (const u of last.units) {
  console.log(
    `  ${String(u.id).padStart(2)} ${u.type.padEnd(20)} ${u.fac === 0 ? 'ROME' : 'GERM'} ` +
    `${String(u.alive).padStart(3)}/${String(u.init).padStart(3)} (${String(u.x).padStart(5)},${String(u.z).padStart(5)}) ` +
    `${(ORDER[u.order] ?? u.order).padEnd(10)} mor ${String(u.mor).padStart(3)}/${u.maxMorale ?? u.maxMor} ` +
    `${u.lock ? 'LOCK' : '    '} eF ${String(u.engf).padStart(4)} push ${String(u.push).padStart(5)} ` +
    `yaw ${String(u.yawDeg).padStart(4)}deg drift ${String(u.drift).padStart(3)}m`
  );
}

const worst = last.units
  .filter((u) => u.terms)
  .sort((a, b) => a.mor / (a.maxMor || 1) - b.mor / (b.maxMor || 1))
  .slice(0, 4);
console.log('\nmorale pressure breakdown (four lowest-morale units, points/sec after discipline):');
for (const u of worst) {
  console.log(`  ${u.type.padEnd(20)} mor ${u.mor}  ` +
    Object.entries(u.terms).map(([k, v]) => `${k}:${v}`).join(' '));
}

console.log(`\nstate legend: ${STATE.map((s, i) => `${i}=${s}`).join(' ')}`);

if (errors.length) {
  console.log(`\n${errors.length} console error(s):`);
  for (const e of [...new Set(errors)].slice(0, 15)) console.log(`  ${e}`);
}

await browser.close();
if (server) server.kill('SIGTERM');
process.exit(0);
