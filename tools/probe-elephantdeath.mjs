#!/usr/bin/env node
/**
 * What happens on the tick a war elephant dies.
 *
 * The owner's report is "when they die they just disappear". A screenshot cannot tell an
 * animal that was removed from the instance buffer from one that fell through the floor or
 * one that is playing a clip out of shot, so this reads the *buffer* rather than the frame:
 * how many elephant instances the tier submits, how many crew instances the soldier tier
 * carries, and what the ragdoll system thinks it owns, tick by tick across the death.
 *
 *   node tools/probe-elephantdeath.mjs --port=5578 [--shots=DIR]
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
const SHOTS = args.get('shots') ? path.resolve(ROOT, args.get('shots')) : null;

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
console.log(`server: ${base}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(`PAGE ERROR: ${e.message}`); console.error('PAGE ERROR:', e.message); });
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE:', m.text()); });
await page.goto(`${base}/?harness=1&quality=ultra`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 150000 });

// ---------------------------------------------------------------------------
// Stand one squadron of elephants on clean ground and kill half of them.
// ---------------------------------------------------------------------------
const setup = await page.evaluate(async () => {
  const g = window.__game;
  const b = g.battle;

  // Clear the scenario: 8,600 men swamp the buffers we want to read.
  for (const u of b.units) { u.destroyed = true; u.alive = 0; }
  for (let i = 0; i < b.pool.count; i++) b.pool.state[i] = 11;
  for (const name of ['tactical-ai', 'general-ai', 'battleFlow', 'autoEngage', 'pathfinding', 'morale']) {
    const sys = g.engine.ctx.tryGet(name);
    if (sys && sys.fixedUpdate) sys.fixedUpdate = () => {};
  }

  const id = b.spawnUnit('war-elephants', 0, -120, 0, 'loose');
  const u = b.unitById(id);
  if (!u) return { error: 'spawn failed' };
  g.engine.advance(1.5, 166);

  // Put the camera on them, from the side, low: the fall reads across the frame.
  const cam = g.engine.ctx.tryGet('camera');
  const m = b.members ?? u.members;
  return {
    unitId: id,
    members: [...u.members],
    hasCam: !!cam,
    x: b.pool.x[u.members[0]], z: b.pool.z[u.members[0]],
    n: u.members.length,
    _m: !!m,
  };
});
if (setup.error) { console.error(setup.error); await browser.close(); if (server) server.kill('SIGTERM'); process.exit(1); }
console.log(`spawned ${setup.n} elephants at (${setup.x.toFixed(1)}, ${setup.z.toFixed(1)})`);

await page.evaluate(({ x, z }) => {
  const g = window.__game;
  const cam = g.engine.ctx.tryGet('camera');
  if (cam?.jumpTo) cam.jumpTo(x, z, 0.30);
  if (cam) { cam.yaw = 0.6; cam.pitch = 0.42; }
  g.engine.advance(0.6, 166);
}, { x: setup.x, z: setup.z });

if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
await shot('00-alive');

// ---------------------------------------------------------------------------
// Read the tiers, tick by tick, through the death.
// ---------------------------------------------------------------------------
const trace = await page.evaluate(async ({ members }) => {
  const g = window.__game;
  const b = g.battle;
  const p = b.pool;
  const scene = g.engine.ctx.scene;
  const rag = g.engine.ctx.tryGet('ragdoll');
  const rs = g.engine.ctx.tryGet('unitRender');

  const meshByName = new Map();
  scene.traverse((o) => { if (o.isMesh && o.name) meshByName.set(o.name, o); });
  const eleMesh = meshByName.get('war-elephants');
  const soldierMeshes = [...meshByName.entries()]
    .filter(([n]) => n.startsWith('soldiers-')).map(([, m]) => m);

  const sample = (t) => ({
    t,
    ele: eleMesh ? eleMesh.geometry.instanceCount : -1,
    eleVis: eleMesh ? eleMesh.visible : null,
    men: soldierMeshes.reduce((a, m) => a + (m.visible ? m.geometry.instanceCount : 0), 0),
    states: members.map((i) => p.state[i]),
    animTime: members.map((i) => +p.animTime[i].toFixed(3)),
    ragTier: members.map((i) => (rag?.hasCorpse ? (rag.hasCorpse(i) ? 1 : 0) : -1)),
    y: members.map((i) => +p.y[i].toFixed(2)),
    eleClip: members.map((i) => (rs?.probeElephant ? (rs.probeElephant(i)?.clip ?? -1) : -2)),
    elePhase: members.map((i) => (rs?.probeElephant ? +(rs.probeElephant(i)?.phase ?? -1).toFixed(3) : -2)),
    corpseSim: rag?.simulatedCount ?? -1,
    census: rag?.census ?? null,
  });

  const out = [];
  out.push({ ...sample(0), note: 'before' });

  // Kill them all with one lethal blow apiece, from the same side.
  const killT = 0;
  for (const i of members) b.damage(i, 1e6, p.x[i] - 6, p.z[i], -1);
  out.push({ ...sample(killT), note: 'same tick as damage(), before any step' });

  const marks = [0.033, 0.1, 0.25, 0.5, 1.0, 2.0, 3.0, 6.0, 12.0];
  let acc = 0;
  for (const m of marks) {
    g.engine.advance(m - acc, 166);
    acc = m;
    out.push({ ...sample(+acc.toFixed(3)), note: '' });
  }
  return out;
}, { members: setup.members });

console.log('\n=== ELEPHANT DEATH TRACE ===');
console.log('t      eleInst  eleVis  menInst  state[0] animT[0] ragdoll[0] eleClip[0] elePhase[0] simSlots  note');
for (const r of trace) {
  console.log(
    `${String(r.t).padStart(6)} ${String(r.ele).padStart(8)} ${String(r.eleVis).padStart(7)} `
    + `${String(r.men).padStart(8)} ${String(r.states[0]).padStart(8)} ${String(r.animTime[0]).padStart(8)} `
    + `${String(r.ragTier[0]).padStart(10)} ${String(r.eleClip[0]).padStart(10)} `
    + `${String(r.elePhase[0]).padStart(11)} ${String(r.corpseSim).padStart(9)}  ${r.note}`
  );
}
const before = trace[0];
const after = trace[trace.length - 1];
console.log(`\nelephant instances: ${before.ele} alive -> ${after.ele} at t+12s`);
console.log(`crew/soldier instances: ${before.men} alive -> ${after.men} at t+12s`);
console.log(`ragdoll census: ${JSON.stringify(after.census)}`);
console.log(after.ele === 0
  ? 'CONFIRMED: the animal is gone from the instance buffer.'
  : `carcasses drawn: ${after.ele}`);

await shot('01-dead-12s');

// A frame mid-fall
await page.evaluate(() => { window.__game.engine.advance(0.0001, 166); });
await shot('02-settled');

console.log(errors.length ? `\npage errors: ${errors.length}` : '\nno page errors');
await browser.close();
if (server) server.kill('SIGTERM');
