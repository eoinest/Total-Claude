#!/usr/bin/env node
/**
 * What a dead elephant costs, and whether men flow round it.
 *
 * Three questions, all interleaved in one session because cross-session comparison is not a
 * measurement on this project:
 *
 *   1. DRAWS      `renderer.info.render.calls` at a fixed camera, elephants alive against
 *                 the same camera with every elephant dead. A carcass rides the same
 *                 instanced tier as a living animal, so the two must be equal.
 *   2. FIXEDUPDATE the whole tick, with the carcass pass live and with it neutered, best of
 *                 N blocks — contention is one-sided so the minimum converges on the
 *                 uncontended cost while the median tracks the rest of the machine.
 *   3. CROWD      how close a living man gets to a carcass's spine while a cohort marches
 *                 over the ground it fell on, and how far the line is deflected.
 *
 *   node tools/probe-elecost.mjs --port=5578
 */

import { chromium } from 'playwright';
import { launchBrowser } from './lib/browser-budget.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5578);
const BLOCKS = Number(args.get('blocks') ?? 7);

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.ok || r.status === 304) return true; }
    catch { /* not up */ }
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

// Through the shared budget: every agent runs these in its own worktree, and on
// 22 Aug 2026 unbudgeted launches reached load 160 on 16 cores and took the machine
// down. `launchBrowser` already defaults the Metal GPU args, so this is shorter too.
const browser = await launchBrowser({ label: 'probe-elecost', port: PORT, root: ROOT });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
await page.goto(`${base}/?harness=1&quality=ultra&enemy=carthage&w=1920&h=1080`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 180000 });

const info = await page.evaluate(() => {
  const b = window.__game.battle;
  const ele = b.units.filter((u) => u.typeId === 'war-elephants' && !u.destroyed);
  return {
    men: b.pool.count,
    units: b.units.length,
    eleUnits: ele.length,
    eleMembers: ele.reduce((a, u) => a + u.members.length, 0),
    first: ele[0] ? { x: b.pool.x[ele[0].members[0]], z: b.pool.z[ele[0].members[0]] } : null,
  };
});
console.log(`Carthaginian field battle: ${info.men} pool entries, ${info.units} units, `
  + `${info.eleUnits} elephant units / ${info.eleMembers} animals`);
if (!info.first) { console.error('no elephants — wrong battle'); await browser.close(); process.exit(1); }

// Settle the battle so the count is the one the budget table measures.
await page.evaluate(() => window.__game.engine.advance(72, 166));

// Re-read where the animals *are* at t+72, not where they deployed: parking on the deploy
// point put the camera 200 m behind them and photographed zero elephant instances.
const at72 = await page.evaluate(() => {
  const b = window.__game.battle;
  const p = b.pool;
  let n = 0;
  let first = null;
  for (let i = 0; i < p.count; i++) {
    if (!b.ridesElephantAt(i) || !p.aliveAt(i)) continue;
    if (!first) first = { x: p.x[i], z: p.z[i] };
    n++;
  }
  return n ? { ...first, alive: n } : null;
});
if (!at72) { console.error('every elephant is already dead at t+72'); await browser.close(); process.exit(1); }
console.log(`at t+72: ${at72.alive} animals alive, centroid (${at72.x.toFixed(0)}, ${at72.z.toFixed(0)})`);
info.first = at72;

const measureDraws = async (label) => page.evaluate(({ label, x, z }) => {
  const g = window.__game;
  g.setCamera(x, z, 0.42, Math.PI * 0.5);
  // `advance` renders every frame and `Engine.frame` resets `info` at the top of each, so
  // this reads the last frame's counts. Never call `engine.frame()` with no argument to
  // force one: `Time.beginFrame(undefined)` puts a NaN through the accumulator and every
  // later `advance` silently returns zero fixed steps — which is what made the two arms
  // below read exactly 0.000 ms and a marching cohort not move at all.
  g.engine.advance(0.4, 166);
  const r = g.engine.renderer.info.render;
  let eleInst = -1;
  g.engine.ctx.scene.traverse((o) => {
    if (o.isMesh && o.name === 'war-elephants') eleInst = o.visible ? o.geometry.instanceCount : 0;
  });
  return { label, calls: r.calls, tris: r.triangles, eleInst };
}, { label, x: info.first.x, z: info.first.z });

const alive = await measureDraws('elephants alive');

// Every elephant killed, from the same side, then let them settle.
await page.evaluate(() => {
  const b = window.__game.battle;
  const p = b.pool;
  for (let i = 0; i < p.count; i++) {
    if (b.ridesElephantAt(i) && p.aliveAt(i)) b.damage(i, 1e6, p.x[i] - 6, p.z[i], -1);
  }
  window.__game.engine.advance(6, 166);
});
const dead = await measureDraws('elephants dead (carcasses)');
const aliveAgain = await measureDraws('re-shoot alive arm (drift check)');

console.log('\n=== 1. DRAWS (1920x1080 ultra, camera parked on the elephant line) ===');
for (const r of [alive, dead, aliveAgain]) {
  console.log(`${r.label.padEnd(32)} calls ${String(r.calls).padStart(4)}  `
    + `tris ${(r.tris / 1e6).toFixed(2)}M  elephant instances ${r.eleInst}`);
}
console.log(dead.calls === alive.calls
  ? `PASS draws: a carcass costs 0 additional draw calls (${alive.calls} both arms)`
  : `draws moved ${alive.calls} -> ${dead.calls}`);

// ---------------------------------------------------------------------------
// 2. fixedUpdate, interleaved
// ---------------------------------------------------------------------------
const timing = await page.evaluate(async ({ blocks }) => {
  const g = window.__game;
  const b = g.battle;
  const sys = g.battle;
  const proto = Object.getPrototypeOf(sys);
  // `engine.advance` runs whole frames, render included, so timing it measures the GPU and
  // the rest of the machine. Wrap the one method under test instead and accumulate.
  const realFixed = proto.fixedUpdate;
  const realPart = proto.partCarcasses;
  let acc = 0;
  let ticks = 0;
  sys.fixedUpdate = function (dt, ctx) {
    const t0 = performance.now();
    realFixed.call(this, dt, ctx);
    acc += performance.now() - t0;
    ticks++;
  };
  let lastTicks = 0;
  const block = (n) => {
    acc = 0; ticks = 0;
    g.engine.advance(n / 30, 1000 / 30);
    lastTicks = ticks;
    return ticks ? acc / ticks : -1;
  };
  const arms = { on: [], off: [] };
  for (let k = 0; k < blocks; k++) {
    // Neuter only the carcass pass, leaving every other write in the tick intact.
    sys.partCarcasses = realPart;
    arms.on.push(block(30));
    sys.partCarcasses = function () {};
    arms.off.push(block(30));
  }
  sys.partCarcasses = realPart;
  sys.fixedUpdate = realFixed;
  return {
    arms, carcasses: (b.elephantCarcasses ?? []).length, men: b.pool.count,
    ticksPerBlock: lastTicks, clockGrain: (() => {
      // Chromium coarsens `performance.now()` without cross-origin isolation. If the grain
      // is bigger than the thing being measured every arm reads zero and looks like a pass.
      let g2 = Infinity;
      let t0 = performance.now();
      for (let k = 0; k < 200000; k++) {
        const t1 = performance.now();
        if (t1 > t0) { g2 = Math.min(g2, t1 - t0); t0 = t1; }
      }
      return +g2.toFixed(5);
    })(),
  };
}, { blocks: BLOCKS });

const stat = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return { best: s[0], median: s[(s.length / 2) | 0] };
};
const on = stat(timing.arms.on);
const off = stat(timing.arms.off);
console.log(`\n=== 2. BattleSystem.fixedUpdate, ${BLOCKS} interleaved blocks of 30 ticks, `
  + `${timing.men} men, ${timing.carcasses} carcasses ===`);
console.log(`ticks seen per block ${timing.ticksPerBlock}, performance.now grain ${timing.clockGrain} ms`);
console.log(`carcass pass live   best ${on.best.toFixed(4)} ms  median ${on.median.toFixed(4)} ms`);
console.log(`carcass pass off    best ${off.best.toFixed(4)} ms  median ${off.median.toFixed(4)} ms`);
console.log(`delta (best-of)     ${(on.best - off.best).toFixed(4)} ms`);

// ---------------------------------------------------------------------------
// 3. Do men flow round it?
// ---------------------------------------------------------------------------
const crowd = await page.evaluate(async () => {
  const g = window.__game;
  const b = g.battle;
  const p = b.pool;
  const { UnitOrder } = await import('/src/sim/types.ts');
  /*
   * A controlled march rather than the live battle. Ordering the surviving Roman line at
   * t+78 to walk over the elephants produced *zero* samples within ten metres in sixty
   * seconds: the units were locked in contact, and a contact lock ignores a move order. So
   * clear the field and stage it — one squadron, one cohort, one straight line of advance.
   */
  for (const u of b.units) { u.destroyed = true; u.alive = 0; }
  for (let i = 0; i < p.count; i++) p.state[i] = 11;
  for (const n of ['tactical-ai', 'general-ai', 'battleFlow', 'autoEngage', 'morale']) {
    const s = g.engine.ctx.tryGet(n);
    if (s && s.fixedUpdate) s.fixedUpdate = () => {};
  }
  void UnitOrder;
  const eid = b.spawnUnit('war-elephants', 0, -120, 0, 'loose');
  const ele = b.unitById(eid);
  if (!ele) return { error: 'spawn failed' };
  g.engine.advance(2, 166);
  const carc = [];
  for (const i of ele.members) { b.damage(i, 1e6, p.x[i] - 6, p.z[i], -1); carc.push(i); }
  // Let them come down and settle before anyone stands on them.
  g.engine.advance(4, 166);

  /*
   * A cohort deployed *onto* the ground the animals fell on, rather than marched into it.
   *
   * Marching one in was tried twice and both times measured the steering rather than the
   * carcass: a cohort ordered forty metres forward covered 1.3 m in forty seconds while
   * drifting 10.5 m sideways, which is a formation re-dressing under a 180-degree facing
   * change and has nothing to do with an elephant. Deploying on top asks the one question
   * this pass exists to answer — does a living man get pushed out of a dead animal — with
   * no other system in the way. It is also the case a player produces, by closing a line
   * over the spot where the beast went down.
   */
  const rid = b.spawnUnit('legio-cohort', 0, -120, Math.PI, 'line');
  const rome = b.unitById(rid);
  if (!rome) return { error: 'cohort spawn failed' };
  const marched = 1;
  const startZ = p.z[rome.members[0]];

  const spine = (e, jx, jz) => {
    const size = 0.9 + p.variant[e] * 0.2;
    const half = 1.05 * size;
    const ax = Math.sin(p.facing[e]) * half;
    const az = Math.cos(p.facing[e]) * half;
    const rx = jx - p.x[e];
    const rz = jz - p.z[e];
    const len2 = ax * ax + az * az;
    const t = len2 > 1e-9 ? Math.max(-1, Math.min(1, (rx * ax + rz * az) / len2)) : 0;
    return Math.hypot(rx - ax * t, rz - az * t);
  };
  const radiusOf = (e) => 1.30 * (0.9 + p.variant[e] * 0.2) + 0.42;

  // How many of the cohort are standing inside a body, sampled at deploy and then per second.
  const insideNow = () => {
    let n = 0;
    let worst = Infinity;
    for (const j of rome.members) {
      if (!p.aliveAt(j)) continue;
      for (const e of carc) {
        if (p.state[e] !== 11) continue;
        const d = spine(e, p.x[j], p.z[j]);
        if (d < worst) worst = d;
        // A tenth of a metre of tolerance: the pass is budgeted, so a man shoved hard into
        // a body clears it over two or three ticks rather than in one.
        if (d < radiusOf(e) - 0.10) { n++; break; }
      }
    }
    return { n, worst };
  };

  const t0 = insideNow();
  const trace = [];
  for (let step = 0; step < 20; step++) {
    g.engine.advance(1.0, 166);
    const s = insideNow();
    trace.push(s.n);
  }
  const tEnd = insideNow();
  let drift = 0;
  for (const j of rome.members) if (p.aliveAt(j)) drift += Math.abs(p.x[j] - 0);
  return {
    carcasses: carc.length, marched,
    cohort: rome.members.length,
    capsuleRadius: +radiusOf(carc[0]).toFixed(3),
    menInsideABodyAtDeploy: t0.n,
    perSecond: trace,
    menInsideABodyAfter20s: tEnd.n,
    closestToSpineAtDeploy: +t0.worst.toFixed(3),
    closestToSpineAfter20s: +tEnd.worst.toFixed(3),
    meanAbsXAfter: +(drift / rome.members.length).toFixed(2),
    cohortZ: [+startZ.toFixed(1), +p.z[rome.members[0]].toFixed(1)],
    carcassZ: +p.z[carc[0]].toFixed(1),
  };
});
console.log('\n=== 3. CROWD ===');
console.log(JSON.stringify(crowd, null, 2));
if (!crowd.error) {
  console.log(crowd.menInsideABodyAtDeploy > 0 && crowd.menInsideABodyAfter20s === 0
    ? `PASS crowd: ${crowd.menInsideABodyAtDeploy} men deployed inside a carcass, 0 left after 20 s`
    : `crowd: ${crowd.menInsideABodyAtDeploy} inside at deploy -> ${crowd.menInsideABodyAfter20s} after 20 s`);
}

await browser.close();
if (server) server.kill('SIGTERM');
