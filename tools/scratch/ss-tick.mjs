#!/usr/bin/env node
/**
 * The anatomy of one simulation tick, by function, at a stated headcount.
 *
 * `probe-frametime` and `probe-siegescale` answer "which subsystem"; at 3,440 men the answer
 * is `battle`, and `battle` is 2,819 lines. This wraps the named methods inside it so the
 * answer can be a function. Every method is wrapped in place — nothing is reimplemented — and
 * the wrappers are `performance.now()` pairs, so a method called once per tick and a method
 * called once per man both come out as milliseconds per tick.
 *
 * Headcount is printed in every row because a tick-time delta that is really a population
 * delta is the standing trap on this project: `fittedUnitScale` silently drops the Carthage
 * assault from 3,440 men to ~1,510 at `quality=low`.
 */
import { chromium } from 'playwright';
const args = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const PORT = Number(args.get('port') ?? 5788);
const MAP = args.get('map') ?? 'carthage';
const SCEN = args.get('scenario') ?? 'assault';
const Q = args.get('quality') ?? 'ultra';
const AT = (args.get('at') ?? '0,120,280').split(',').map(Number);
const TICKS = Number(args.get('ticks') ?? 300);
const url = `http://127.0.0.1:${PORT}/?harness=1&autoplay=1&w=1280&h=720&map=${MAP}&scenario=${SCEN}&quality=${Q}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
console.log('url:', url);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await page.evaluate(() => window.__game.engine.stop());
const setup = await page.evaluate(() => {
  const g = window.__game, b = g.battle, e = g.engine;
  const combat = e.context.tryGet('combat');
  const proj = e.context.tryGet('projectiles');
  const acc = {}; const found = []; const missing = [];
  window.__tick = { acc, ticks: 0 };
  const wrap = (owner, name, label) => {
    if (!owner || typeof owner[name] !== 'function') { missing.push(label); return; }
    const f = owner[name].bind(owner);
    acc[label] = 0;
    owner[name] = (...a) => { const t = performance.now(); const r = f(...a); acc[label] += performance.now() - t; return r; };
    found.push(label);
  };
  wrap(b.hash, 'rebuild', 'hash.rebuild');
  for (const m of ['resolveCrowding', 'steerSoldiers', 'integrate', 'updateAnimationState',
    'trackOwnedAnchors', 'updateUnitOrder', 'collectRoutes', 'partCarcasses', 'nearestEnemyFront']) wrap(b, m, 'battle.' + m);
  for (const m of ['preSteer', 'postIntegrate']) wrap(b.siege, m, 'siege.' + m);
  for (const m of ['rebuildAttackerCounts', 'surveyUnits', 'fightUnits', 'resolvePush']) wrap(combat, m, 'combat.' + m);
  for (const m of ['integrate', 'launch']) wrap(proj, m, 'proj.' + m);
  // Tick counter from the engine, so "per tick" is the real number of fixed steps.
  const orig = e.frame.bind(e);
  e.frame = (n) => { orig(n); window.__tick.ticks += e.time.ticksThisFrame; };
  return { found, missing };
});
console.log('wrapped:', setup.found.length, ' missing:', setup.missing.join(',') || 'none');
let prev = 0;
for (const at of AT) {
  if (at > prev) { await page.evaluate((s) => window.__game.fastForward(s), at - prev); prev = at; }
  const r = await page.evaluate((n) => {
    const g = window.__game, e = g.engine, b = g.battle, t = window.__tick;
    for (const k of Object.keys(t.acc)) t.acc[k] = 0;
    t.ticks = 0;
    let alive = 0; const p = b.pool;
    for (let i = 0; i < p.count; i++) if (p.aliveAt(i)) alive++;
    const t0 = performance.now();
    // Renderless so the numbers are the simulation and not the frame around it.
    e.advance(n / 30, 1000 / 60, { render: false });
    const wall = performance.now() - t0;
    const flow = e.context.tryGet('battleFlow');
    return { acc: { ...t.acc }, ticks: t.ticks, wall, alive,
      storm: flow?.objective?.stormOnWall ?? null, t: +g.simTime().toFixed(1) };
  }, TICKS);
  const rows = Object.entries(r.acc).map(([k, v]) => [k, v / Math.max(1, r.ticks)])
    .filter(([, v]) => v > 0.002).sort((a, b) => b[1] - a[1]);
  const named = rows.reduce((a, [, v]) => a + v, 0);
  console.log(`\nt+${r.t}  alive ${r.alive}  stormOnWall ${r.storm}  ticks ${r.ticks}  wall ${r.wall.toFixed(0)}ms`);
  for (const [k, v] of rows) console.log(`    ${v.toFixed(3)} ms/tick  ${(v / named * 100).toFixed(1).padStart(5)}%  ${k}`);
  console.log(`    ${named.toFixed(3)} ms/tick  total of the named functions`);
}
if (errors.length) console.log('ERRORS:', errors.slice(0, 5));
await browser.close();
