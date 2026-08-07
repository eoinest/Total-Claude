#!/usr/bin/env node
/**
 * Film a war elephant dying, and the field afterwards.
 *
 * An API-level pass on this once reported "the carcass is in the buffer" while the animal
 * was standing in the ground up to its knees, so this exists to be looked at. It stands one
 * squadron of elephants on clean ground with Roman infantry behind them, kills them, and
 * shoots the collapse frame by frame from a low camera at the range a player watches from.
 * Then it marches the infantry over the bodies to see whether the line parts round them.
 *
 *   node tools/film-elephant.mjs --port=5578 --out=screenshots/eledeath
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5578);
const OUT = path.resolve(ROOT, args.get('out') ?? 'screenshots/eledeath');
const ZOOM = Number(args.get('zoom') ?? 0.13);

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
if (!(await waitForServer(base, 1200))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 90000))) { console.error('vite did not start'); process.exit(1); }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); console.error('PAGE ERROR:', e.message); });
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE:', m.text()); });
await page.goto(`${base}/?harness=1&quality=ultra&hud=0`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 150000 });

fs.mkdirSync(OUT, { recursive: true });
const shot = async (name) => { await page.screenshot({ path: path.join(OUT, `${name}.png`) }); };

const setup = await page.evaluate(async () => {
  const g = window.__game;
  const b = g.battle;
  const { UnitOrder } = await import('/src/sim/types.ts');
  for (const u of b.units) { u.destroyed = true; u.alive = 0; }
  for (let i = 0; i < b.pool.count; i++) b.pool.state[i] = 11;
  for (const name of ['tactical-ai', 'general-ai', 'battleFlow', 'autoEngage', 'morale']) {
    const sys = g.engine.ctx.tryGet(name);
    if (sys && sys.fixedUpdate) sys.fixedUpdate = () => {};
  }
  const hud = document.querySelector('#hud') ?? document.querySelector('.hud');
  if (hud) hud.style.display = 'none';
  for (const el of document.querySelectorAll('body > div')) {
    if (el.id !== 'app' && !el.querySelector('canvas')) el.style.display = 'none';
  }

  const eid = b.spawnUnit('war-elephants', 0, -120, 0, 'loose');
  const rid = b.spawnUnit('legio-cohort', 0, -172, Math.PI, 'line');
  const ele = b.unitById(eid);
  const rome = b.unitById(rid);
  if (!ele || !rome) return { error: 'spawn failed' };
  rome.order = UnitOrder.Hold;
  g.engine.advance(2.0, 166);
  return {
    eleId: eid, romeId: rid,
    members: [...ele.members],
    x: b.pool.x[ele.members[0]], z: b.pool.z[ele.members[0]],
  };
});
if (setup.error) { console.error(setup.error); await browser.close(); if (server) server.kill('SIGTERM'); process.exit(1); }

// A low camera off the animal's left flank, so the fall crosses the frame.
const park = async (zoom, yaw, dx = 0, dz = 0) => page.evaluate(({ x, z, zoom, yaw, dx, dz }) => {
  window.__game.setCamera(x + dx, z + dz, zoom, yaw);
  window.__game.engine.advance(0.5, 166);
}, { x: setup.x, z: setup.z, zoom, yaw, dx, dz });

// One animal, on its own, so the collapse is legible: the rest of the squadron is put well
// out of frame rather than filtered, because a filtered arm is a different code path.
await page.evaluate(({ members }) => {
  const b = window.__game.battle;
  for (let k = 1; k < members.length; k++) {
    const i = members[k];
    b.pool.x[i] += 90;
    b.pool.z[i] += 40 + k * 6;
  }
  window.__game.engine.advance(0.2, 166);
}, { members: setup.members });

await park(ZOOM, Math.PI * 0.5, 0, 0);
await shot('a0-standing');

const step = async (name, seconds) => {
  await page.evaluate((s) => window.__game.engine.advance(s, 166), seconds);
  await shot(name);
};

const stats = await page.evaluate(({ members }) => {
  const g = window.__game;
  const b = g.battle;
  for (const i of members) b.damage(i, 1e6, b.pool.x[i] - 6, b.pool.z[i], -1);
  return { killed: members.length };
}, { members: setup.members });
console.log(`killed ${stats.killed} elephants`);

await shot('a1-t000');
await step('a2-t030', 0.30);
await step('a3-t060', 0.30);
await step('a4-t100', 0.40);
await step('a5-t160', 0.60);
await step('a6-t260-settled', 1.00);
await step('a7-t600', 3.40);

// The field afterwards, from further out.
await park(0.34, Math.PI * 0.5);
await shot('b0-field-mid');
await park(0.62, Math.PI * 0.5);
await shot('b1-field-strategic');

// And the line marching over the bodies.
await page.evaluate(async ({ romeId }) => {
  const g = window.__game;
  const { UnitOrder } = await import('/src/sim/types.ts');
  const u = g.battle.unitById(romeId);
  u.order = UnitOrder.MoveTo;
  u.targetX = 0;
  u.targetZ = -76;
  u.running = false;
  u.waypoints.length = 0;
}, { romeId: setup.romeId });
await park(0.30, Math.PI * 0.5);
await step('c0-advance-000', 0.1);
await step('c1-advance-100', 10);
await step('c2-advance-160', 6);
await step('c3-advance-220', 6);
await park(0.44, Math.PI * 1.0);
await shot('c4-from-behind');

const after = await page.evaluate(() => {
  const g = window.__game;
  const b = g.battle;
  const scene = g.engine.ctx.scene;
  let ele = -1;
  let men = 0;
  scene.traverse((o) => {
    if (!o.isMesh || !o.name) return;
    if (o.name === 'war-elephants') ele = o.visible ? o.geometry.instanceCount : 0;
    if (o.name.startsWith('soldiers-') && o.visible) men += o.geometry.instanceCount;
  });
  const carc = b.elephantCarcasses ?? [];
  // How close does a living man get to a carcass spine? Should not be inside it.
  let worst = Infinity;
  const p = b.pool;
  for (const e of carc) {
    for (let j = 0; j < p.count; j++) {
      if (!p.aliveAt(j)) continue;
      if (b.ridesElephantAt(j)) continue;
      const d = Math.hypot(p.x[j] - p.x[e], p.z[j] - p.z[e]);
      if (d < worst) worst = d;
    }
  }
  return {
    ele, men, carcasses: carc.length,
    nearestLivingToCarcassCentre: Number.isFinite(worst) ? +worst.toFixed(2) : null,
    renderer: g.engine.renderer.info.render.calls,
  };
});
console.log(JSON.stringify(after, null, 2));
console.log(errors.length ? `page errors: ${errors.length}` : 'no page errors');
console.log(`frames in ${OUT}`);

await browser.close();
if (server) server.kill('SIGTERM');
